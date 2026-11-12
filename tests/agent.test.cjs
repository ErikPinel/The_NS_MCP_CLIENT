const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, plain, text, tool, budget } = require('./harness.cjs');

test('a direct answer makes one HTTPS request and persists only complete messages', () => {
    const f = fixture({ outputs: [text('Hello')] });
    const result = f.load('agent').answer([], 'Hi');
    assert.equal(result.answer, 'Hello');
    assert.equal(result.llmRequests, 1);
    assert.equal(result.toolCalls, 0);
    assert.deepEqual(plain(result.history), [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]);
    const request = f.calls.http[0];
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.authorization, 'Bearer {custsecret_nsai_openai}');
    assert.equal(request.body.store, false);
    assert.equal(request.body.tool_choice, 'auto');
    assert.equal(request.body.parallel_tool_calls, true);
    assert.equal(request.body.tools.length, 4);
    assert.ok(request.body.tools.every(schema => schema.strict && schema.type === 'function'));
});

test('all calls in one response execute in process and return matching call IDs', () => {
    const f = fixture({ outputs: [[tool('a'), tool('b', 'get_record', { type: 'customer', id: '42', fields: null })], text('Found')] });
    const result = f.load('agent').answer([], 'Look up account and customer');
    assert.equal(result.llmRequests, 2);
    assert.equal(result.toolCalls, 2);
    assert.equal(f.calls.record.length, 1);
    const outputs = f.calls.http[1].body.input.filter(item => item.type === 'function_call_output');
    assert.deepEqual(outputs.map(item => item.call_id), ['a', 'b']);
    assert.ok(outputs.every(item => JSON.parse(item.output).ok));
    assert.equal(result.history.length, 2);
});

test('the fifth request always reserves a final answer, not a fifth tool iteration', () => {
    const f = fixture({
        outputs: [
            [tool('1', 'get_record', { type: 'customer', id: '1', fields: null })],
            [tool('2', 'get_record', { type: 'customer', id: '2', fields: null })],
            [tool('3', 'get_record', { type: 'customer', id: '3', fields: null })],
            [tool('4', 'get_record', { type: 'customer', id: '4', fields: null })],
            text('Final answer')
        ]
    });
    const result = f.load('agent').answer([], 'Find four records');
    assert.equal(result.llmRequests, 5);
    assert.equal(result.toolCalls, 4);
    assert.equal(f.calls.http[4].body.tool_choice, 'none');
    assert.deepEqual(f.calls.http.map(call => call.body.tool_choice), ['auto', 'auto', 'auto', 'auto', 'none']);
});

test('tools requested on the final response fail without a sixth request', () => {
    const f = fixture({ outputs: [[tool('a')]] });
    f.load('config').maxLlmRequests = 1;
    assert.throws(() => f.load('agent').answer([], 'Hi'), /final-answer limit/);
    assert.equal(f.calls.http.length, 1);
});

test('time reserve switches to a final-only request early', () => {
    const f = fixture({ outputs: [text('Partial results only')] });
    const result = f.load('agent').answer([], 'Hi', Date.now() - 150000);
    assert.equal(result.llmRequests, 1);
    assert.equal(f.calls.http[0].body.tool_choice, 'none');
});

test('insufficient time or governance prevents another HTTPS request', () => {
    const timed = fixture();
    assert.throws(() => timed.load('agent').answer([], 'Hi', Date.now() - 200000), /time or governance budget/);
    assert.equal(timed.calls.http.length, 0);
    const lowUsage = fixture({ usage: 79 });
    assert.throws(() => lowUsage.load('agent').answer([], 'Hi'), /time or governance budget/);
    assert.equal(lowUsage.calls.http.length, 0);
});

test('tool budget errors become explicit outputs and force the next request to final-only', () => {
    const f = fixture({ outputs: [[tool('1'), tool('2'), tool('3')], text('Reached a limit')] });
    const result = f.load('agent').answer([], 'Account info repeatedly');
    assert.equal(result.llmRequests, 2);
    assert.equal(f.calls.http[1].body.tool_choice, 'none');
    const outputs = f.calls.http[1].body.input.filter(item => item.type === 'function_call_output');
    assert.equal(JSON.parse(outputs[2].output).error.code, 'TOOL_BUDGET_EXCEEDED');
});

test('invalid messages and oversized conversations fail explicitly', () => {
    const f = fixture();
    for (const message of ['', ' ', null, 'x'.repeat(4001)]) {
        assert.throws(() => f.load('agent').answer([], message), /Enter a message/);
    }
    assert.throws(() => f.load('agent').answer([{ role: 'user', content: 'x'.repeat(100001) }], 'Hi'), /too large/);
    assert.equal(f.calls.http.length, 0);
});

test('refusals are displayed, but empty or incomplete responses are not success-shaped', () => {
    const f = fixture({ outputs: [[{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help with that.' }] }]] });
    assert.equal(f.load('agent').answer([], 'Hi').answer, 'Cannot help with that.');
    assert.throws(() => fixture().load('agent').answer([], 'Hi'), /no answer/);
    assert.throws(() => fixture({ httpBody: '{"status":"incomplete","output":[]}' }).load('agent').answer([], 'Hi'), /did not complete/);
});

test('HTTP, invalid JSON and transport errors are explicit and never include API error bodies', () => {
    for (const code of [401, 429, 500]) {
        const f = fixture({ httpCode: code, httpBody: 'SENSITIVE_PROVIDER_BODY' });
        assert.throws(() => f.load('agent').answer([], 'Hi'), new RegExp(`HTTP ${code}`));
        assert.ok(!JSON.stringify(f.calls.logs).includes('SENSITIVE_PROVIDER_BODY'));
    }
    assert.throws(() => fixture({ httpBody: '{broken' }).load('agent').answer([], 'Hi'), /invalid JSON/);
    assert.throws(() => fixture({ httpError: new Error('SENSITIVE_TRANSPORT_MESSAGE') }).load('agent').answer([], 'Hi'), /could not be reached/);
});

test('quota 429 errors identify API billing instead of recommending futile retries', () => {
    for (const metadata of [
        { code: 'insufficient_quota' },
        { code: null, type: 'insufficient_quota' },
        { code: 'billing_hard_limit_reached' }
    ]) {
        const f = fixture({ httpCode: 429, httpBody: JSON.stringify({ error: { ...metadata, message: 'SENSITIVE_PROVIDER_MESSAGE' } }) });
        assert.throws(() => f.load('agent').answer([], 'Hi'), error => {
            assert.equal(error.code, 'OPENAI_QUOTA_EXCEEDED');
            assert.equal(error.status, 429);
            assert.match(error.message, /billing/);
            assert.match(error.message, /ChatGPT subscriptions do not include API credits/);
            assert.match(error.message, /Retrying will not help/);
            assert.ok(!error.message.includes('SENSITIVE_PROVIDER_MESSAGE'));
            return true;
        });
        assert.equal(f.calls.http.length, 1);
        assert.ok(!JSON.stringify(f.calls.logs).includes('SENSITIVE_PROVIDER_MESSAGE'));
        assert.ok(f.calls.logs.some(entry => JSON.parse(entry.details).category === 'quota'));
    }
});

test('rate-limit 429 errors recommend waiting and do not retry inside the Suitelet', () => {
    for (const metadata of [{ code: 'rate_limit_exceeded' }, { type: 'rate_limit_exceeded' }]) {
        const f = fixture({ httpCode: 429, httpBody: JSON.stringify({ error: metadata }) });
        assert.throws(() => f.load('agent').answer([], 'Hi'), error => {
            assert.equal(error.code, 'OPENAI_RATE_LIMITED');
            assert.equal(error.status, 429);
            assert.match(error.message, /Wait briefly/);
            assert.match(error.message, /request and token limits/);
            return true;
        });
        assert.equal(f.calls.http.length, 1);
    }
});

test('unclassified or malformed 429 responses preserve uncertainty without exposing provider content', () => {
    for (const body of [
        'SENSITIVE_PROVIDER_BODY',
        'null', '{}', '{"error":null}',
        '{"error":{"code":"SENSITIVE_PROVIDER_CODE","type":"unknown","message":"SENSITIVE_PROVIDER_MESSAGE"}}'
    ]) {
        const f = fixture({ httpCode: 429, httpBody: body });
        assert.throws(() => f.load('agent').answer([], 'Hi'), error => {
            assert.equal(error.code, 'OPENAI_LIMIT_EXCEEDED');
            assert.equal(error.status, 429);
            assert.match(error.message, /did not identify whether/);
            assert.ok(!error.message.includes('SENSITIVE_PROVIDER'));
            return true;
        });
        assert.equal(f.calls.http.length, 1);
        assert.ok(!JSON.stringify(f.calls.logs).includes('SENSITIVE_PROVIDER'));
    }
});

test('unknown and malformed tools produce errors and do not call NetSuite data APIs', () => {
    const f = fixture();
    const tools = f.load('tools');
    assert.equal(JSON.parse(tools.execute('__proto__', '{}', budget())).error.code, 'UNKNOWN_TOOL');
    assert.equal(JSON.parse(tools.execute('get_record', '{broken', budget())).error.code, 'INVALID_ARGUMENTS');
    assert.equal(JSON.parse(tools.execute('get_account_info', '{"extra":true}', budget())).error.code, 'INVALID_ARGUMENTS');
    assert.equal(f.calls.record.length, 0);
    assert.ok(f.calls.logs.length >= 3);
});

test('total tool count, result size and per-tool governance are bounded', () => {
    const f = fixture();
    const tools = f.load('tools');
    const used = budget();
    used.toolCalls = 12;
    assert.equal(JSON.parse(tools.execute('get_account_info', '{}', used)).error.code, 'TOOL_BUDGET_EXCEEDED');
    f.state.rows = [{ oversized: 'x'.repeat(17000) }];
    assert.equal(JSON.parse(tools.execute('execute_suiteql', '{"query":"SELECT id FROM customer","limit":1}', budget())).error.code, 'RESULT_TOO_LARGE');
    f.natives['N/record'].load = () => { f.state.usage -= 30; return { id: 1, getFields: () => ['entityid'], getValue: () => 'value' }; };
    assert.equal(JSON.parse(tools.execute('get_record', '{"type":"customer","id":"1","fields":null}', budget())).error.code, 'TOOL_BUDGET_EXCEEDED');
});
