/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/url', 'N/log', './config', './policy', './sessions', './agent', './html', './errors', './trace'],
    (url, log, config, policy, sessions, agent, html, errors, traces) => {
        function writeJson(response, data) {
            response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
            response.write({ output: JSON.stringify(data) });
        }

        function onRequest(context) {
            const startedAt = Date.now();
            const { request, response } = context;
            let state;
            let user;
            let trace;
            try {
                response.setHeader({ name: 'Cache-Control', value: 'no-store' });
                response.setHeader({ name: 'X-Content-Type-Options', value: 'nosniff' });
                user = policy.authorize();
                if (request.method === 'GET') {
                    state = sessions.create(user);
                    response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
                    response.write({
                        output: html.render({
                            id: state.id, token: state.token, revision: state.revision,
                            maxMessageChars: config.maxMessageChars,
                            endpoint: url.resolveScript({
                                scriptId: 'customscript_nsai_controller',
                                deploymentId: 'customdeploy_nsai_controller',
                                returnExternalUrl: false
                            })
                        })
                    });
                    return;
                }
                if (request.method !== 'POST') {
                    errors.fail('METHOD_NOT_ALLOWED', 'Only GET and POST are supported.', 405);
                }
                const contentType = request.headers['content-type'] || request.headers['Content-Type'] || '';
                if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
                    errors.fail('CONTENT_TYPE_REQUIRED', 'Send the request as application/json.', 415);
                }
                if (typeof request.body !== 'string' || request.body.length > 30000) {
                    errors.fail('INVALID_REQUEST', 'The chat request is too large.', 413);
                }
                let payload;
                try {
                    payload = JSON.parse(request.body);
                } catch (error) {
                    errors.fail('INVALID_JSON', 'The chat request is not valid JSON.');
                }
                if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
                    Object.keys(payload).some(name => !['id', 'token', 'revision', 'message'].includes(name))) {
                    errors.fail('INVALID_REQUEST', 'The chat request has unsupported fields.');
                }
                state = sessions.load(user, payload);
                state.busy = true;
                sessions.save(user, state);
                trace = traces.create(startedAt);
                const result = agent.answer(state.history, payload.message, startedAt, trace);
                if (JSON.stringify(result.history).length > config.maxConversationChars) {
                    errors.fail('CONVERSATION_TOO_LARGE', 'This conversation is full. Start a new chat.', 413);
                }
                state.history = result.history;
                state.revision += 1;
                state.busy = false;
                state.expiresAt = Date.now() + config.sessionTtl * 1000;
                sessions.save(user, state);
                writeJson(response, {
                    ok: true, answer: result.answer, revision: state.revision,
                    llmRequests: result.llmRequests, toolCalls: result.toolCalls,
                    trace: result.trace
                });
            } catch (error) {
                if (state && state.busy && user) {
                    state.busy = false;
                    try {
                        sessions.save(user, state);
                    } catch (cacheError) {
                        log.error({ title: 'NSAI session recovery failed', details: cacheError.name || 'CACHE_ERROR' });
                    }
                }
                log.error({ title: 'NSAI request failed', details: error.code || error.name || 'INTERNAL_ERROR' });
                const safeError = errors.publicError(error);
                if (request.method === 'GET') {
                    response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
                    response.write({ output: `<h2>NetSuite AI Chat</h2><p>${html.escape(safeError.message)}</p>` });
                } else {
                    writeJson(response, {
                        ok: false, error: safeError, status: error.safe === true ? error.status : 500,
                        trace: trace ? traces.finish(trace, safeError) : undefined
                    });
                }
            }
        }

        return { onRequest };
    });
