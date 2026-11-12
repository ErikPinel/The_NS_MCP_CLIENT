/**
 * @NApiVersion 2.1
 */
define([], () => {
    function preview(value, limit = 1200) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return { text: text.slice(0, limit), truncated: text.length > limit, originalChars: text.length };
    }

    function publicText(item) {
        if (typeof item.content === 'string') {
            return item.content;
        }
        return (Array.isArray(item.content) ? item.content : [])
            .filter(part => part.type === 'output_text' || part.type === 'refusal' || part.type === 'input_text')
            .map(part => part.type === 'refusal' ? part.refusal : part.text)
            .filter(text => typeof text === 'string').join('\n');
    }

    function reasoningSummary(items) {
        return items.filter(item => item.type === 'reasoning')
            .flatMap(item => Array.isArray(item.summary) ? item.summary : [])
            .filter(part => part.type === 'summary_text' && typeof part.text === 'string')
            .map(part => part.text).join('\n');
    }

    function publicItem(item) {
        if (item.type === 'reasoning') {
            return { type: 'reasoning', summary: preview(reasoningSummary([item])) };
        }
        if (item.type === 'function_call') {
            return {
                type: item.type, name: String(item.name).slice(0, 160),
                callId: String(item.call_id).slice(0, 160),
                arguments: preview(typeof item.arguments === 'string' ? item.arguments : '')
            };
        }
        if (item.type === 'function_call_output') {
            return {
                type: item.type, callId: String(item.call_id).slice(0, 160),
                output: preview(typeof item.output === 'string' ? item.output : '')
            };
        }
        if (item.type === 'message' || item.role === 'user' || item.role === 'assistant') {
            return { type: 'message', role: item.role, content: preview(publicText(item)) };
        }
        return { type: 'not_shown', note: 'This output type has no public text preview.' };
    }

    function history(items) {
        const shown = items.slice(-8);
        return {
            ...preview(shown.map(publicItem), 4000),
            totalItems: items.length,
            omittedItems: items.length - shown.length
        };
    }

    function response(data) {
        const items = data && Array.isArray(data.output) ? data.output : [];
        const usage = {};
        const rawUsage = data && data.usage;
        if (rawUsage && typeof rawUsage === 'object') {
            const counts = {
                inputTokens: rawUsage.input_tokens,
                outputTokens: rawUsage.output_tokens,
                totalTokens: rawUsage.total_tokens,
                cachedInputTokens: rawUsage.input_tokens_details && rawUsage.input_tokens_details.cached_tokens,
                reasoningTokens: rawUsage.output_tokens_details && rawUsage.output_tokens_details.reasoning_tokens
            };
            Object.keys(counts).forEach(key => {
                if (Number.isInteger(counts[key]) && counts[key] >= 0) {
                    usage[key] = counts[key];
                }
            });
        }
        return {
            output: history(items),
            reasoningSummary: preview(reasoningSummary(items)),
            usage: Object.keys(usage).length ? usage : null
        };
    }

    function create(startedAt = Date.now()) {
        return { startedAt, durationMs: 0, llm: [], tools: [], omittedToolCalls: 0 };
    }

    function finish(trace, error) {
        trace.durationMs = Math.max(0, Date.now() - trace.startedAt);
        trace.status = error ? 'failed' : 'completed';
        if (error) {
            trace.error = error;
        }
        return trace;
    }

    return { create, finish, preview, history, response };
});
