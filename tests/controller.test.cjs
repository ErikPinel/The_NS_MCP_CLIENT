const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, text } = require('./harness.cjs');

function session(f) {
    const response = f.request('GET');
    const match = response.body.match(/<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(match);
    return JSON.parse(match[1]);
}

test('GET issues a cache-backed, role-bound session without exposing the API secret', () => {
    const f = fixture();
    const response = f.request('GET');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.ok(!response.body.includes('custsecret'));
    assert.ok(!response.body.includes('__NSAI_BOOTSTRAP__'));
    const first = session(f);
    const second = session(f);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.token, second.token);
    assert.ok(first.endpoint.startsWith('/app/'));
});

test('POST preserves server-side history and increments revision across successful turns', () => {
    const f = fixture({ outputs: [text('First answer'), text('Second answer')] });
    const bootstrap = session(f);
    const { id, token } = bootstrap;
    const first = JSON.parse(f.request('POST', { id, token, revision: 0, message: 'First question' }).body);
    assert.equal(first.ok, true);
    assert.equal(first.revision, 1);
    const second = JSON.parse(f.request('POST', { id, token, revision: 1, message: 'Second question' }).body);
    assert.equal(second.ok, true);
    assert.equal(second.revision, 2);
    assert.equal(f.calls.http[1].body.input.length, 3);
    assert.equal(f.calls.http[1].body.input[1].content, 'First answer');
    const saved = JSON.parse(f.cache.get(`7:3:${id}`));
    assert.equal(saved.history.length, 4);
    assert.equal(saved.busy, false);
});

test('forged history, bad CSRF tokens, stale revisions and role changes are rejected', () => {
    const f = fixture();
    const { id, token } = session(f);
    const payload = { id, token, revision: 0, message: 'Hi' };
    assert.equal(JSON.parse(f.request('POST', { ...payload, history: [] }).body).error.code, 'INVALID_REQUEST');
    assert.equal(JSON.parse(f.request('POST', { ...payload, token: 'forged' }).body).error.code, 'INVALID_TOKEN');
    assert.equal(JSON.parse(f.request('POST', { ...payload, revision: 1 }).body).error.code, 'SESSION_CONFLICT');
    f.state.user.id = 8;
    assert.equal(JSON.parse(f.request('POST', payload).body).error.code, 'SESSION_EXPIRED');
    f.state.user.id = 7;
    f.state.user.role = 4;
    f.load('config').allowedRoleIds.push('4');
    assert.equal(JSON.parse(f.request('POST', payload).body).error.code, 'SESSION_EXPIRED');
    assert.equal(f.calls.http.length, 0);
});

test('cache eviction, expiry, busy sessions and turn limits return actionable errors', () => {
    const f = fixture();
    const { id, token } = session(f);
    const key = `7:3:${id}`;
    const payload = { id, token, revision: 0, message: 'Hi' };
    const original = JSON.parse(f.cache.get(key));
    for (const [patch, code] of [
        [{ expiresAt: 0 }, 'SESSION_EXPIRED'],
        [{ busy: true }, 'SESSION_CONFLICT'],
        [{ history: Array(24).fill({ role: 'user', content: 'x' }) }, 'TURN_LIMIT']
    ]) {
        f.cache.set(key, JSON.stringify({ ...original, ...patch }));
        assert.equal(JSON.parse(f.request('POST', payload).body).error.code, code);
    }
    f.cache.delete(key);
    assert.equal(JSON.parse(f.request('POST', payload).body).status, 410);
});

test('failed model requests unlock the session without adding partial history', () => {
    const f = fixture({ httpCode: 429 });
    const { id, token } = session(f);
    const payload = { id, token, revision: 0, message: 'Hi' };
    const failed = JSON.parse(f.request('POST', payload).body);
    assert.equal(failed.ok, false);
    const saved = JSON.parse(f.cache.get(`7:3:${id}`));
    assert.equal(saved.busy, false);
    assert.equal(saved.revision, 0);
    assert.equal(saved.history.length, 0);
    f.state.httpCode = 200;
    f.state.outputs = [text('Recovered')];
    assert.equal(JSON.parse(f.request('POST', payload).body).ok, true);
});

test('classified quota errors reach the chat with an actionable message and logical 429 status', () => {
    const f = fixture({
        httpCode: 429,
        httpBody: '{"error":{"code":"insufficient_quota","message":"SENSITIVE_PROVIDER_MESSAGE"}}'
    });
    const { id, token } = session(f);
    const result = JSON.parse(f.request('POST', { id, token, revision: 0, message: 'Hi' }).body);
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.error.code, 'OPENAI_QUOTA_EXCEEDED');
    assert.match(result.error.message, /API credits/);
    assert.ok(!JSON.stringify(result).includes('SENSITIVE_PROVIDER_MESSAGE'));
    assert.equal(JSON.parse(f.cache.get(`7:3:${id}`)).busy, false);
});

test('method, content type, request shape and message validation happen before LLM calls', () => {
    const f = fixture();
    assert.equal(JSON.parse(f.request('PUT', {}).body).status, 405);
    assert.equal(JSON.parse(f.request('POST', {}, { 'content-type': 'text/plain' }).body).status, 415);
    assert.equal(JSON.parse(f.request('POST', '{broken').body).error.code, 'INVALID_JSON');
    assert.equal(JSON.parse(f.request('POST', 'x'.repeat(30001)).body).status, 413);
    assert.equal(JSON.parse(f.request('POST', null).body).error.code, 'INVALID_REQUEST');
    const { id, token } = session(f);
    assert.equal(JSON.parse(f.request('POST', { id, token, revision: 0 }).body).error.code, 'INVALID_MESSAGE');
    assert.equal(f.calls.http.length, 0);
});

test('bootstrap serialization cannot break out of a script tag', () => {
    const f = fixture();
    const html = f.load('html').render({ endpoint: '</script><img src=x onerror=alert(1)>', value: '$&\u2028' });
    assert.ok(!html.includes('</script><img'));
    const json = html.match(/<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(json).endpoint, '</script><img src=x onerror=alert(1)>');
    assert.equal(JSON.parse(json).value, '$&\u2028');
});

test('Portlet embeds only the internal Suitelet and reports denied access', () => {
    const f = fixture();
    const context = { portlet: {} };
    f.load('portlet').render(context);
    assert.equal(context.portlet.title, 'NetSuite AI Chat');
    assert.match(context.portlet.html, /<iframe/);
    assert.ok(context.portlet.html.includes('&amp;deploy=1'));
    f.load('config').allowedRoleIds = [];
    f.load('portlet').render(context);
    assert.ok(context.portlet.html.includes('not enabled'));
    assert.ok(!context.portlet.html.includes('<iframe'));
});
