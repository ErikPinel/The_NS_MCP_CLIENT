const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, text, tool } = require('./harness.cjs');

function session(f) {
    const html = f.request('GET').body;
    return JSON.parse(html.match(/<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/)[1]);
}

test('traces capture each model request and tool call with timing and governance', () => {
    let now = 1000;
    class Clock { static now() { now += 10; return now; } }
    const f = fixture({
        Date: Clock,
        outputs: [[tool('lookup', 'get_record', { type: 'customer', id: '1', fields: ['entityid'] })], text('Found')]
    });
    const result = f.load('agent').answer([], 'Find customer');
    const trace = result.trace;
    assert.equal(trace.status, 'completed');
    assert.equal(trace.llm.length, 2);
    assert.equal(trace.tools.length, 1);
    assert.equal(trace.llm[0].httpStatus, 200);
    assert.equal(trace.llm[0].status, 'completed');
    assert.equal(trace.llm[0].toolChoice, 'auto');
    assert.ok(trace.llm[1].input.text.includes('function_call_output'));
    assert.ok(trace.llm[1].output.text.includes('Found'));
    assert.equal(trace.tools[0].name, 'get_record');
    assert.equal(trace.tools[0].callId, 'lookup');
    assert.equal(trace.tools[0].modelRequest, 1);
    assert.equal(trace.tools[0].governanceUsed, 10);
    assert.equal(trace.tools[0].status, 'completed');
    assert.ok(trace.tools[0].result.text.includes('value:entityid'));
    assert.ok(trace.llm.every(entry => entry.durationMs > 0));
    assert.ok(trace.tools[0].durationMs > 0);
    assert.ok(trace.durationMs > 0);
});

test('preview limits and omissions are exact and do not shorten actual model context or tools', () => {
    const f = fixture({
        rows: [{ value: 'r'.repeat(14000) + 'RESULT_END' }],
        outputs: [[tool('sql', 'execute_suiteql', {
            query: "SELECT id FROM customer WHERE companyname = '" + 'q'.repeat(2000) + "QUERY_END'", limit: 1
        })], text('Done')]
    });
    const result = f.load('agent').answer([], 'Look up data');
    assert.equal(result.trace.tools[0].arguments.text.length, 1200);
    assert.equal(result.trace.tools[0].arguments.truncated, true);
    assert.equal(result.trace.tools[0].result.text.length, 1200);
    assert.equal(result.trace.tools[0].result.truncated, true);
    assert.ok(f.calls.query[0].query.includes('QUERY_END'));
    const actualResult = f.calls.http[1].body.input.find(item => item.type === 'function_call_output');
    assert.ok(actualResult.output.includes('RESULT_END'));
    const long = f.load('trace').history(Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `${index}:` + 'x'.repeat(2000) })));
    assert.equal(long.totalItems, 20);
    assert.equal(long.omittedItems, 12);
    assert.equal(long.text.length, 4000);
    assert.equal(long.truncated, true);
    assert.equal(f.load('trace').preview('x'.repeat(1200)).truncated, false);
    assert.equal(f.load('trace').preview('x'.repeat(1201)).truncated, true);
});

test('tool errors are visible in their originating turn trace', () => {
    const f = fixture({ outputs: [[tool('bad', 'get_record', { type: 'customer', id: '0', fields: null })], text('Invalid record ID')] });
    const result = f.load('agent').answer([], 'Look up an invalid ID');
    assert.equal(result.trace.tools[0].status, 'failed');
    assert.ok(result.trace.tools[0].result.text.includes('INVALID_ID'));
});

test('reasoning summaries and token counts are captured, but raw/encrypted reasoning is never exposed', () => {
    const reasoning = {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Public summary of the lookup.' }],
        content: [{ type: 'reasoning_text', text: 'PRIVATE_THINKING_NOT_FOR_UI' }],
        encrypted_content: 'ENCRYPTED_NOT_FOR_UI'
    };
    const f = fixture({
        httpBody: JSON.stringify({
            status: 'completed',
            output: [reasoning, ...text('Answer')],
            usage: {
                input_tokens: 100, output_tokens: 40, total_tokens: 140,
                input_tokens_details: { cached_tokens: 20 },
                output_tokens_details: { reasoning_tokens: 10 },
                unrelated: 'PRIVATE_USAGE_METADATA'
            }
        })
    });
    const result = f.load('agent').answer([], 'Question');
    const entry = result.trace.llm[0];
    assert.equal(entry.reasoningSummary.text, 'Public summary of the lookup.');
    assert.equal(entry.usage.inputTokens, 100);
    assert.equal(entry.usage.cachedInputTokens, 20);
    assert.equal(entry.usage.reasoningTokens, 10);
    const serialized = JSON.stringify(result.trace);
    for (const hidden of ['PRIVATE_THINKING_NOT_FOR_UI', 'ENCRYPTED_NOT_FOR_UI', 'PRIVATE_USAGE_METADATA', 'Authorization', 'custsecret_nsai_openai']) {
        assert.ok(!serialized.includes(hidden), hidden);
    }
});

test('public-summary mode is opt-in and encrypted reasoning stays only in internal continuation', () => {
    const reasoning = {
        type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public explanation.' }],
        encrypted_content: 'INTERNAL_CONTINUATION_ONLY'
    };
    const f = fixture({ outputs: [[reasoning, tool('account')], text('Done')] });
    f.load('config').reasoningSummary = true;
    const result = f.load('agent').answer([], 'Account info');
    assert.equal(f.calls.http[0].body.reasoning.summary, 'auto');
    assert.deepEqual(f.calls.http[0].body.include, ['reasoning.encrypted_content']);
    assert.equal(f.calls.http[1].body.input.find(item => item.type === 'reasoning').encrypted_content, 'INTERNAL_CONTINUATION_ONLY');
    assert.ok(!JSON.stringify(result.trace).includes('INTERNAL_CONTINUATION_ONLY'));
    const standard = fixture({ outputs: [text('Done')] });
    standard.load('agent').answer([], 'Hello');
    assert.equal(standard.calls.http[0].body.reasoning, undefined);
    assert.equal(standard.calls.http[0].body.include, undefined);
});

test('extra tool attempts are explicitly counted instead of growing the browser trace indefinitely', () => {
    const f = fixture({
        outputs: [Array.from({ length: 30 }, (_, index) => tool(`call-${index}`)), text('Limit reached')]
    });
    const result = f.load('agent').answer([], 'Repeated account calls');
    assert.equal(result.trace.tools.length, 13);
    assert.equal(result.trace.omittedToolCalls, 17);
    assert.equal(result.trace.llm.length, 2);
    assert.equal(result.trace.llm[1].toolChoice, 'none');
});

test('controller returns partial traces on API errors without copying raw error bodies', () => {
    const f = fixture({ httpCode: 429, httpBody: '{"error":{"code":"insufficient_quota","message":"RAW_ERROR_NOT_FOR_UI"}}' });
    const { id, token } = session(f);
    const result = JSON.parse(f.request('POST', { id, token, revision: 0, message: 'Question' }).body);
    assert.equal(result.ok, false);
    assert.equal(result.trace.status, 'failed');
    assert.equal(result.trace.llm.length, 1);
    assert.equal(result.trace.llm[0].status, 'failed');
    assert.equal(result.trace.llm[0].httpStatus, 429);
    assert.equal(result.trace.llm[0].error.code, 'OPENAI_QUOTA_EXCEEDED');
    assert.ok(!JSON.stringify(result).includes('RAW_ERROR_NOT_FOR_UI'));
    assert.ok(!JSON.stringify(result.trace).includes(token));
});

test('turn traces are isolated and never enter cached conversation history or later model input', () => {
    const f = fixture({ outputs: [[tool('first-turn-call')], text('First answer'), text('Second answer')] });
    const { id, token } = session(f);
    const first = JSON.parse(f.request('POST', { id, token, revision: 0, message: 'First question' }).body);
    const second = JSON.parse(f.request('POST', { id, token, revision: 1, message: 'Second question' }).body);
    assert.equal(first.trace.llm.length, 2);
    assert.equal(first.trace.tools.length, 1);
    assert.equal(second.trace.llm.length, 1);
    assert.equal(second.trace.tools.length, 0);
    assert.ok(!JSON.stringify(second.trace).includes('first-turn-call'));
    assert.ok(!JSON.stringify(f.calls.http[2].body.input).includes('first-turn-call'));
    const saved = f.cache.get(`7:3:${id}`);
    assert.ok(!saved.includes('first-turn-call'));
    assert.ok(!saved.includes('"trace"'));
    assert.equal(JSON.parse(saved).history.length, 4);
});

test('invalid API JSON and transport errors preserve safe failed-request diagnostics', () => {
    for (const overrides of [
        { httpBody: '{broken' },
        { httpError: new Error('PRIVATE_TRANSPORT_DETAILS') }
    ]) {
        const f = fixture(overrides);
        const { id, token } = session(f);
        const result = JSON.parse(f.request('POST', { id, token, revision: 0, message: 'Question' }).body);
        assert.equal(result.trace.status, 'failed');
        assert.equal(result.trace.llm[0].status, 'failed');
        assert.ok(!JSON.stringify(result.trace).includes('PRIVATE_TRANSPORT_DETAILS'));
    }
});
