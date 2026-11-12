/**
 * @NApiVersion 2.1
 */
define(['N/runtime', './config', './policy', './tools', './openai', './errors', './trace'],
    (runtime, config, policy, tools, openai, errors, traces) => {
        function answer(history, message, startedAt = Date.now(), trace = traces.create(startedAt)) {
            policy.authorize();
            if (typeof message !== 'string' || !message.trim() || message.length > config.maxMessageChars) {
                errors.fail('INVALID_MESSAGE', `Enter a message of 1-${config.maxMessageChars} characters.`);
            }
            const conversation = history.concat({ role: 'user', content: message.trim() });
            const context = {
                deadline: startedAt + config.maxElapsedMs,
                toolCalls: 0, callsByTool: {}, stopTools: false
            };
            const schemas = tools.schemas();
            for (let run = 0; run < config.maxLlmRequests; run += 1) {
                if (Date.now() + config.requestReserveMs >= context.deadline ||
                    runtime.getCurrentScript().getRemainingUsage() < config.governanceReserve) {
                    errors.fail('AGENT_BUDGET_EXCEEDED', 'The request reached its time or governance budget. Try a narrower request.', 503);
                }
                if (JSON.stringify(conversation).length > config.maxConversationChars) {
                    errors.fail('CONVERSATION_TOO_LARGE', 'The conversation is too large. Start a new chat or request less data.', 413);
                }
                const finalOnly = run === config.maxLlmRequests - 1 || context.stopTools ||
                    Date.now() + 2 * config.requestReserveMs >= context.deadline ||
                    runtime.getCurrentScript().getRemainingUsage() < config.governanceReserve + 50;
                const modelTrace = {
                    number: run + 1,
                    model: config.model,
                    toolChoice: finalOnly ? 'none' : 'auto',
                    tools: schemas.map(schema => schema.name),
                    input: traces.history(conversation),
                    status: 'running',
                    startedAt: Date.now()
                };
                trace.llm.push(modelTrace);
                let output;
                try {
                    output = openai.respond(conversation, schemas, finalOnly, modelTrace);
                    modelTrace.status = 'completed';
                } catch (error) {
                    modelTrace.status = 'failed';
                    modelTrace.error = errors.publicError(error);
                    throw error;
                } finally {
                    modelTrace.durationMs = Math.max(0, Date.now() - modelTrace.startedAt);
                }
                conversation.push(...output);
                const calls = output.filter(item => item.type === 'function_call');
                if (calls.length > 0) {
                    if (finalOnly) {
                        errors.fail('OPENAI_INVALID_RESPONSE', 'OpenAI requested a tool after the final-answer limit.', 502);
                    }
                    for (const call of calls) {
                        if (typeof call.call_id !== 'string' || !call.call_id ||
                            typeof call.name !== 'string' || typeof call.arguments !== 'string') {
                            errors.fail('OPENAI_INVALID_RESPONSE', 'OpenAI returned an invalid tool call.', 502);
                        }
                        const toolTrace = {
                            modelRequest: run + 1,
                            callId: call.call_id.slice(0, 160),
                            name: call.name.slice(0, 160),
                            arguments: traces.preview(call.arguments),
                            startedAt: Date.now()
                        };
                        if (trace.tools.length < config.maxToolCalls + 1) {
                            trace.tools.push(toolTrace);
                        } else {
                            trace.omittedToolCalls += 1;
                        }
                        const usageBefore = runtime.getCurrentScript().getRemainingUsage();
                        const result = tools.execute(call.name, call.arguments, context);
                        const parsed = JSON.parse(result);
                        toolTrace.durationMs = Math.max(0, Date.now() - toolTrace.startedAt);
                        toolTrace.governanceUsed = Math.max(0, usageBefore - runtime.getCurrentScript().getRemainingUsage());
                        toolTrace.status = parsed.ok ? 'completed' : 'failed';
                        toolTrace.result = traces.preview(parsed);
                        conversation.push({
                            type: 'function_call_output',
                            call_id: call.call_id,
                            output: result
                        });
                    }
                    continue;
                }
                const text = output.filter(item => item.type === 'message')
                    .flatMap(item => Array.isArray(item.content) ? item.content : [])
                    .map(item => item.type === 'output_text' ? item.text : item.type === 'refusal' ? item.refusal : '')
                    .filter(value => typeof value === 'string' && value.trim()).join('\n');
                if (!text) {
                    errors.fail('EMPTY_ANSWER', 'OpenAI returned no answer. Please try again.', 502);
                }
                // Only complete human-readable turns persist; tool traces stay in this request.
                return {
                    answer: text,
                    history: history.concat({ role: 'user', content: message.trim() }, { role: 'assistant', content: text }),
                    llmRequests: run + 1,
                    toolCalls: context.toolCalls,
                    trace: traces.finish(trace)
                };
            }
            errors.fail('AGENT_LIMIT', 'The agent could not produce a final answer within five model requests.', 502);
        }

        return { answer };
    });
