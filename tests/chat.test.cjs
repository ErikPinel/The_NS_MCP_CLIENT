const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { root } = require('./harness.cjs');

function chat(fetch) {
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase();
            this.children = [];
            this.events = {};
            this.value = '';
            this.textContent = '';
            this.disabled = false;
            this.open = false;
        }
        addEventListener(name, handler) { this.events[name] = handler; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        appendChild(child) { child.parent = this; this.children.push(child); }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
        set innerHTML(value) { throw new Error('Render untrusted data using text nodes, not innerHTML'); }
        focus() { this.focused = true; }
        requestSubmit() { return this.events.submit({ preventDefault() {} }); }
    }
    const bootstrap = {
        id: 'session-id', token: 'csrf-token', revision: 0,
        endpoint: '/internal-suitelet', maxMessageChars: 4000
    };
    const ids = ['bootstrap', 'chat-form', 'message', 'messages', 'status', 'send', 'new-chat'];
    const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
    elements.bootstrap.textContent = JSON.stringify(bootstrap);
    let reloads = 0;
    const source = fs.readFileSync(path.join(root, 'chat.html'), 'utf8');
    const inline = source.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(inline, {
        document: {
            getElementById: id => elements[id],
            createElement: tag => new Element(tag),
            createTextNode: value => ({ textContent: value })
        },
        window: { location: { reload() { reloads += 1; } } },
        fetch
    });
    return {
        elements,
        submit: () => elements['chat-form'].requestSubmit(),
        reloads: () => reloads
    };
}

function jsonResponse(body) {
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => body };
}

function descendants(element, predicate) {
    return (element.children || []).flatMap(child => [
        ...(predicate(child) ? [child] : []),
        ...descendants(child, predicate)
    ]);
}

function bubbles(c) {
    return descendants(c.elements.messages, element => (element.className || '').split(' ').includes('message'));
}

function allText(element) {
    return [element.textContent || '', ...descendants(element, () => true).map(child => child.textContent || '')].join('\n');
}

function exampleTrace(label = 'First') {
    const preview = text => ({ text, truncated: false, originalChars: text.length });
    return {
        status: 'completed', durationMs: 200, omittedToolCalls: 0,
        tools: [{
            name: 'get_record', callId: label + '-call', modelRequest: 1,
            status: 'completed', durationMs: 20, governanceUsed: 10,
            arguments: preview('{"type":"customer","id":"1","fields":null}'),
            result: { text: label + ' <img src=x onerror=alert(1)>', truncated: true, originalChars: 5000 }
        }],
        llm: [{
            number: 1, model: label + '-model', toolChoice: 'auto', tools: ['get_record'],
            status: 'completed', durationMs: 180, httpStatus: 200,
            input: preview(label + ' prompt'), output: preview(label + ' model response'),
            reasoningSummary: preview(label + ' public summary'), usage: { inputTokens: 30, outputTokens: 10 }
        }]
    };
}

test('chat submits only new text and CSRF metadata, renders model output as literal text', async () => {
    const requests = [];
    const c = chat(async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({
            ok: true, answer: '<img src=x onerror=alert(1)>',
            revision: requests.length, llmRequests: 2, toolCalls: 2
        });
    });
    c.elements.message.value = 'First question';
    await c.submit();
    assert.equal(requests[0].url, '/internal-suitelet');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        id: 'session-id', token: 'csrf-token', revision: 0, message: 'First question'
    });
    assert.equal(bubbles(c)[1].children[1].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(c.elements.message.value, '');
    assert.equal(c.elements.message.maxLength, 4000);
    assert.equal(c.elements.status.textContent, '2 model request(s), 2 tool call(s)');
    c.elements.message.value = 'Second question';
    await c.submit();
    assert.equal(JSON.parse(requests[1].options.body).revision, 1);
    c.elements['new-chat'].events.click();
    assert.equal(c.reloads(), 1);
});

test('only one message can be submitted while a fetch is in progress', async () => {
    let finish;
    let requests = 0;
    const c = chat(() => {
        requests += 1;
        return new Promise(resolve => { finish = resolve; });
    });
    c.elements.message.value = 'Question';
    const first = c.submit();
    assert.equal(c.elements.send.disabled, true);
    assert.equal(c.elements['new-chat'].disabled, true);
    await c.submit();
    assert.equal(requests, 1);
    finish(jsonResponse({ ok: true, answer: 'Answer', revision: 1, llmRequests: 1, toolCalls: 0 }));
    await first;
    assert.equal(c.elements.send.disabled, false);
    assert.equal(c.elements['new-chat'].disabled, false);
    assert.equal(c.elements.message.focused, true);
});

test('JSON errors, login redirects and network errors retain their own failed turn and draft', async () => {
    for (const fetch of [
        async () => jsonResponse({ ok: false, error: { message: 'Chat expired. Start a new chat.' } }),
        async () => ({ ok: true, headers: { get: () => 'text/html' } }),
        async () => { throw new Error('Connection lost'); }
    ]) {
        const c = chat(fetch);
        c.elements.message.value = 'Keep this draft';
        await c.submit();
        assert.equal(c.elements.status.className, 'error');
        assert.ok(c.elements.status.textContent.length > 0);
        assert.equal(c.elements.message.value, 'Keep this draft');
        assert.equal(c.elements.messages.children.length, 1);
        assert.equal(bubbles(c).length, 2);
        assert.match(bubbles(c)[1].className, /error/);
        assert.match(allText(c.elements.messages), /Run details - unavailable/);
        assert.equal(c.elements.send.disabled, false);
    }
});

test('each turn has independent, collapsed tool, LLM and public-summary histories', async () => {
    let requests = 0;
    const c = chat(async () => {
        requests += 1;
        return jsonResponse({
            ok: true, answer: 'Answer ' + requests, revision: requests, llmRequests: 1, toolCalls: 1,
            trace: exampleTrace(requests === 1 ? 'First' : 'Second')
        });
    });
    c.elements.message.value = 'Question one';
    await c.submit();
    const first = c.elements.messages.children[0];
    const firstDetails = first.children[1];
    assert.equal(firstDetails.tagName, 'DETAILS');
    assert.equal(firstDetails.open, false);
    assert.match(allText(first), /Tool history \(1\)/);
    assert.match(allText(first), /LLM history \(1\)/);
    assert.match(allText(first), /First public summary/);
    assert.match(allText(first), /Preview shortened from 5000 characters/);
    assert.match(allText(first), /inputTokens/);
    assert.equal(descendants(first, element => element.tagName === 'IMG').length, 0);
    assert.ok(descendants(first, element => element.tagName === 'DETAILS').every(element => element.open === false));
    firstDetails.open = true;
    c.elements.message.value = 'Question two';
    await c.submit();
    const second = c.elements.messages.children[1];
    assert.match(allText(first), /First-call/);
    assert.ok(!allText(first).includes('Second-call'));
    assert.match(allText(second), /Second-call/);
    assert.ok(!allText(second).includes('First-call'));
    assert.equal(firstDetails.open, true);
    assert.equal(second.children[1].open, false);
});

test('failed turns retain partial histories and lack of a public summary is explicit', async () => {
    const trace = exampleTrace();
    trace.status = 'failed';
    trace.llm[0].status = 'failed';
    trace.llm[0].reasoningSummary.text = '';
    trace.llm[0].error = { code: 'OPENAI_HTTP_ERROR', message: 'OpenAI returned HTTP 500.' };
    trace.omittedToolCalls = 3;
    const c = chat(async () => jsonResponse({
        ok: false, error: trace.llm[0].error, trace
    }));
    c.elements.message.value = 'Keep draft';
    await c.submit();
    assert.equal(c.elements.message.value, 'Keep draft');
    const turn = c.elements.messages.children[0];
    assert.match(allText(turn), /First-call/);
    assert.match(allText(turn), /OpenAI returned HTTP 500/);
    assert.match(allText(turn), /did not provide a public reasoning summary/);
    assert.match(allText(turn), /3 additional tool event/);
    assert.equal(bubbles(c).length, 2);
});

test('Enter sends, Shift+Enter and IME composition do not submit', async () => {
    let requests = 0;
    const c = chat(async () => {
        requests += 1;
        return jsonResponse({ ok: true, answer: 'Done', revision: 1, llmRequests: 1, toolCalls: 0 });
    });
    const keydown = c.elements.message.events.keydown;
    c.elements.message.value = 'Question';
    keydown({ key: 'Enter', shiftKey: true });
    keydown({ key: 'Enter', shiftKey: false, isComposing: true });
    assert.equal(requests, 0);
    let prevented = false;
    keydown({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() { prevented = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(prevented, true);
});
