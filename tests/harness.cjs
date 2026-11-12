const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'NSAI');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
    const calls = { http: [], query: [], record: [], search: [], logs: [] };
    const cache = new Map();
    const state = {
        user: { id: 7, role: 3, getPermission: () => 4 },
        usage: 1000,
        rows: [],
        outputs: [],
        httpCode: 200,
        httpBody: undefined,
        httpError: undefined,
        ...overrides
    };
    const modules = new Map();
    const natives = {
        'N/runtime': {
            accountId: 'TEST_ACCOUNT', envType: 'SANDBOX', version: '2026.2',
            getCurrentUser: () => state.user,
            getCurrentScript: () => ({ getRemainingUsage: () => state.usage })
        },
        'N/log': { error: entry => calls.logs.push(plain(entry)) },
        'N/query': {
            runSuiteQL: args => {
                calls.query.push(plain(args));
                state.usage -= 10;
                if (state.queryError) { throw state.queryError; }
                return { asMappedResults: () => state.rows };
            }
        },
        'N/record': {
            load: args => {
                calls.record.push(plain(args));
                state.usage -= 10;
                if (state.recordError) { throw state.recordError; }
                return {
                    id: args.id,
                    getFields: () => state.recordFields || ['entityid', 'companyname', 'isinactive'],
                    getValue: ({ fieldId }) => `value:${fieldId}`
                };
            }
        },
        'N/search': {
            Sort: { ASC: 'ASC' },
            createColumn: args => args,
            createFilter: args => args,
            create: args => {
                calls.search.push(plain(args));
                return {
                    run: () => ({
                        getRange: range => {
                            calls.searchRange = plain(range);
                            state.usage -= 10;
                            if (state.searchError) { throw state.searchError; }
                            return state.rows;
                        }
                    })
                };
            }
        },
        'N/cache': {
            Scope: { PRIVATE: 'PRIVATE' },
            getCache: () => ({
                put: ({ key, value }) => cache.set(key, value),
                get: ({ key }) => cache.get(key) || null
            })
        },
        'N/crypto/random': { generateUUID: randomUUID },
        'N/url': { resolveScript: () => '/app/site/hosting/scriptlet.nl?script=1&deploy=1' },
        'N/file': {
            load: ({ id }) => ({
                getContents: () => fs.readFileSync(path.join(root, path.basename(id)), 'utf8')
            })
        },
        'N/https': {
            createSecureString: ({ input }) => ({
                value: input,
                appendSecureString({ secureString }) { this.value += secureString.value; return this; }
            }),
            post: args => {
                calls.http.push({ body: JSON.parse(args.body), url: args.url, authorization: args.headers.Authorization.value });
                state.usage -= 10;
                if (state.httpError) { throw state.httpError; }
                return {
                    code: state.httpCode,
                    body: state.httpBody === undefined
                        ? JSON.stringify({ status: 'completed', output: state.outputs.shift() || [] })
                        : state.httpBody
                };
            }
        }
    };

    function load(name) {
        if (Object.prototype.hasOwnProperty.call(natives, name)) { return natives[name]; }
        const key = name.replace(/^\.\//, '');
        if (modules.has(key)) { return modules.get(key); }
        let value;
        const source = fs.readFileSync(path.join(root, `${key}.js`), 'utf8');
        vm.runInNewContext(source, {
            define: (deps, factory) => { value = factory(...deps.map(load)); },
            Date: state.Date || Date
        }, { filename: `${key}.js` });
        modules.set(key, value);
        return value;
    }

    load('config').allowedRoleIds = ['3'];
    function request(method, payload, headers = { 'content-type': 'application/json' }) {
        const response = {
            headers: {},
            setHeader({ name, value }) { this.headers[name] = value; },
            write({ output }) { this.body = output; }
        };
        load('controller').onRequest({
            request: { method, headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) },
            response
        });
        return response;
    }

    return { load, calls, state, cache, natives, request };
}

const text = value => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }];
const tool = (id, name = 'get_account_info', args = {}) => ({
    type: 'function_call', call_id: id, name, arguments: JSON.stringify(args)
});
const budget = () => ({ toolCalls: 0, callsByTool: {}, deadline: Date.now() + 240000, stopTools: false });

module.exports = { fixture, plain, text, tool, budget, root };
