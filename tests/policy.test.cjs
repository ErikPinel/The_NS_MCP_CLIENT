const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, plain, budget } = require('./harness.cjs');

test('the chat admission gate remains separate from native record permissions', () => {
    const f = fixture();
    f.load('config').allowedRoleIds = [];
    assert.throws(() => f.load('policy').authorize(), /not enabled/);
    f.load('config').allowedRoleIds = ['3'];
    f.state.user.id = -4;
    assert.throws(() => f.load('policy').authorize(), /not enabled/);
    assert.equal(Object.prototype.hasOwnProperty.call(f.load('config'), 'records'), false);
});

test('record/search schemas have no type or field access allowlists', () => {
    const f = fixture();
    const schemas = f.load('tools').schemas();
    for (const name of ['get_record', 'search_records']) {
        const properties = schemas.find(schema => schema.name === name).parameters.properties;
        assert.equal(properties.type.type, 'string');
        assert.equal(properties.type.enum, undefined);
        assert.equal(properties.fields.items.enum, undefined);
    }
});

test('malformed record types, IDs and field shapes fail before native calls', () => {
    const f = fixture();
    const tools = f.load('tools');
    for (const [args, code] of [
        [{ type: '', id: '1', fields: null }, 'INVALID_RECORD_TYPE'],
        [{ type: {}, id: '1', fields: null }, 'INVALID_RECORD_TYPE'],
        [{ type: 'customer', id: '0', fields: null }, 'INVALID_ID'],
        [{ type: 'customer', id: 'abc', fields: null }, 'INVALID_ID'],
        [{ type: 'customer', id: '1', fields: [] }, 'INVALID_FIELDS'],
        [{ type: 'customer', id: '1', fields: [''] }, 'INVALID_FIELDS'],
        [{ type: 'customer', id: '1', fields: [null] }, 'INVALID_FIELDS'],
        [{ type: 'customer', id: '1', fields: 'companyname' }, 'INVALID_FIELDS'],
        [{ type: 'customer', id: '1', fields: Array(11).fill('entityid') }, 'INVALID_FIELDS'],
        [{ type: 'customer', id: '1' }, 'INVALID_ARGUMENTS']
    ]) {
        const result = JSON.parse(tools.execute('get_record', JSON.stringify(args), budget()));
        assert.equal(result.error.code, code);
    }
    assert.equal(f.calls.record.length, 0);
});

test('record access and arbitrary body fields reach NetSuite without permission prechecks', () => {
    const f = fixture();
    f.state.user.getPermission = () => { throw new Error('Do not perform application permission prechecks'); };
    const tools = f.load('tools');
    for (const type of ['employee', 'purchaseorder', 'customrecord_project']) {
        const result = JSON.parse(tools.execute('get_record', JSON.stringify({
            type, id: '1', fields: ['custrecord_budget', 'department']
        }), budget()));
        assert.equal(result.ok, true);
        assert.deepEqual(Object.keys(result.result.fields), ['custrecord_budget', 'department']);
        assert.equal(f.calls.record.at(-1).type, type);
    }
    f.state.recordFields = ['custrecord_projectname', 'custrecord_budget', 'custrecord_owner'];
    const allFields = JSON.parse(tools.execute('get_record', '{"type":"customrecord_project","id":"1","fields":null}', budget()));
    assert.equal(allFields.ok, true);
    assert.deepEqual(Object.keys(allFields.result.fields), f.state.recordFields);
});

test('SuiteQL delegates standard/custom tables, columns, joins and functions to NetSuite', () => {
    const f = fixture();
    const policy = f.load('policy');
    for (const sql of [
        'SELECT id, companyname FROM customer ORDER BY id',
        "SELECT id FROM customer WHERE companyname = 'update; -- it''s safe'",
        'SELECT COUNT(*) AS total FROM customer WHERE isinactive = \'F\'',
        'SELECT c.id, v.id FROM customer c JOIN vendor v ON c.id = v.id',
        'SELECT id FROM customer WHERE id IN (SELECT id FROM vendor)',
        "SELECT NVL(companyname, 'Unknown') FROM customer",
        'SELECT id FROM customer UNION SELECT id FROM vendor',
        'SELECT e.id, e.department FROM employee e JOIN department d ON e.department=d.id',
        'SELECT custrecord_budget FROM customrecord_project',
        'SELECT * FROM customer, employee',
        'SELECT * FROM other.customer',
        'SELECT * FROM (SELECT * FROM transaction)',
        'SELECT id FROM customer WHERE id IN (SELECT id FROM employee)',
        'SELECT BUILTIN.DF(entity) AS "Customer Name" FROM transaction',
        'SELECT "delete", "value; -- comment" FROM customrecord_project'
    ]) {
        assert.equal(policy.readOnlyQuery(sql), sql);
    }
});

test('SuiteQL still rejects writes, multiple statements and unsupported request syntax', () => {
    const f = fixture();
    const policy = f.load('policy');
    for (const sql of [
        'DELETE FROM customer', 'SELECT id FROM customer; DELETE FROM customer',
        'SELECT * FROM customer -- hidden', 'SELECT /* hidden */ * FROM customer',
        'WITH x AS (SELECT * FROM customer) SELECT * FROM x',
        'SELECT * FROM customer FOR UPDATE', 'SELECT id INTO secret FROM customer',
        'SELECT id FROM customer WHERE companyname = \'unterminated',
        'SELECT id AS "unterminated FROM customer',
        'SELECT id FROM customer WHERE id = ?',
        'SELECT (id FROM customer', 'SELECT id) FROM customer'
    ]) {
        assert.throws(() => policy.readOnlyQuery(sql), undefined, sql);
    }
});

test('SuiteQL executes native queries without permission prechecks and bounds returned rows', () => {
    const f = fixture({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const tools = f.load('tools');
    f.state.user.getPermission = () => { throw new Error('Do not perform application permission prechecks'); };
    const sql = 'SELECT e.id FROM employee e JOIN customrecord_project p ON e.id=p.custrecord_owner';
    const result = JSON.parse(tools.execute('execute_suiteql', JSON.stringify({ query: sql, limit: 2 }), budget()));
    assert.equal(result.ok, true);
    assert.equal(result.result.rows.length, 2);
    assert.equal(result.result.truncated, true);
    assert.deepEqual(f.calls.query[0].params, [3]);
    assert.equal(f.calls.query[0].metaDataProvider, 'SUITE_QL');
    assert.match(f.calls.query[0].query, /WHERE ROWNUM <= \?/);
    assert.ok(f.calls.query[0].query.includes(sql));
});

test('NetSuite permission failures from record/search/query execution are explicit tool errors', () => {
    for (const [name, property, code, args] of [
        ['get_record', 'recordError', 'INSUFFICIENT_PERMISSION', { type: 'employee', id: '1', fields: ['firstname'] }],
        ['search_records', 'searchError', 'SSS_PERMISSION_VIOLATION', { type: 'customrecord_project', filters: [], fields: ['custrecord_budget'], limit: 2 }],
        ['execute_suiteql', 'queryError', 'SUITE_QL_PERMISSION_VIOLATION', { query: 'SELECT id FROM employee', limit: 2 }]
    ]) {
        const nativeError = new Error('CONFIDENTIAL_NATIVE_PERMISSION_MESSAGE');
        nativeError.name = code;
        const f = fixture({ [property]: nativeError });
        f.state.user.getPermission = () => { throw new Error('Do not perform application permission prechecks'); };
        const result = JSON.parse(f.load('tools').execute(name, JSON.stringify(args), budget()));
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'NETSUITE_PERMISSION_DENIED');
        assert.match(result.error.message, /NetSuite denied/);
        assert.equal(f.calls.record.length + f.calls.search.length + f.calls.query.length, 1);
        assert.ok(!JSON.stringify(result).includes('CONFIDENTIAL'));
        assert.ok(!JSON.stringify(f.calls.logs).includes('CONFIDENTIAL'));
    }
});

test('search creates bounded AND filters without joins and excludes transaction line duplicates', () => {
    const f = fixture();
    const tools = f.load('tools');
    const args = { type: 'salesorder', filters: [{ field: 'tranid', operator: 'startswith', values: ['SO'] }], fields: ['tranid', 'total'], limit: 3 };
    const result = JSON.parse(tools.execute('search_records', JSON.stringify(args), budget()));
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls.searchRange, { start: 0, end: 4 });
    assert.deepEqual(f.calls.search[0].filters, [
        { name: 'tranid', operator: 'startswith', values: ['SO'] },
        { name: 'mainline', operator: 'is', values: ['T'] }
    ]);
    assert.deepEqual(plain(f.calls.search[0].columns), [{ name: 'internalid', sort: 'ASC' }, 'tranid', 'total']);
});

test('custom-record search fields and filters reach NetSuite without local allowlists', () => {
    const f = fixture();
    f.state.user.getPermission = () => { throw new Error('Do not perform application permission prechecks'); };
    const args = {
        type: 'customrecord_project',
        filters: [{ field: 'custrecord_budget', operator: 'greaterthan', values: ['100'] }],
        fields: ['custrecord_owner', 'custrecord_budget'],
        limit: 5
    };
    const result = JSON.parse(f.load('tools').execute('search_records', JSON.stringify(args), budget()));
    assert.equal(result.ok, true);
    assert.equal(f.calls.search[0].type, 'customrecord_project');
    assert.deepEqual(f.calls.search[0].filters, [{ name: 'custrecord_budget', operator: 'greaterthan', values: ['100'] }]);
    assert.deepEqual(f.calls.search[0].columns.slice(1), args.fields);
});

test('search fields null returns IDs only, without selecting arbitrary default columns', () => {
    const f = fixture({ rows: [{ id: 42, getValue() { throw new Error('No columns should be read'); } }] });
    const result = JSON.parse(f.load('tools').execute('search_records', JSON.stringify({
        type: 'customrecord_project', filters: [], fields: null, limit: 5
    }), budget()));
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.rows, [{ id: '42', fields: {} }]);
    assert.deepEqual(f.calls.search[0].columns, [{ name: 'internalid', sort: 'ASC' }]);
});

test('dynamic field names cannot mutate the result object prototype', () => {
    const f = fixture();
    const result = JSON.parse(f.load('tools').execute('get_record', JSON.stringify({
        type: 'customrecord_project', id: '1', fields: ['__proto__', 'constructor']
    }), budget()));
    assert.equal(result.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result.fields, '__proto__'), true);
    assert.equal(result.result.fields.__proto__, 'value:__proto__');
    assert.equal(result.result.fields.constructor, 'value:constructor');
});

test('search rejects malformed filters and row limits rather than silently defaulting', () => {
    const f = fixture();
    const tools = f.load('tools');
    const args = { type: 'customer', filters: [], fields: null, limit: 10 };
    for (const value of [0, 101, 2.5, '5']) {
        args.limit = value;
        assert.equal(JSON.parse(tools.execute('search_records', JSON.stringify(args), budget())).error.code, 'INVALID_LIMIT');
    }
    args.limit = null;
    for (const filter of [
        { field: 'entityid', operator: 'unsupported', values: ['x'] },
        { field: 'entityid', operator: 'is', values: [] },
        { field: 'entityid', operator: 'is', values: ['x'], join: 'employee' }
    ]) {
        args.filters = [filter];
        assert.equal(JSON.parse(tools.execute('search_records', JSON.stringify(args), budget())).ok, false);
    }
    assert.equal(f.calls.search.length, 0);
});

test('unexpected NetSuite errors are logged by code without leaking their content', () => {
    const f = fixture({ recordError: new Error('CONFIDENTIAL_RECORD_DATA') });
    const result = JSON.parse(f.load('tools').execute('get_record', '{"type":"customer","id":"1","fields":null}', budget()));
    assert.equal(result.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(result).includes('CONFIDENTIAL'));
    assert.ok(!JSON.stringify(f.calls.logs).includes('CONFIDENTIAL'));
    assert.equal(f.calls.logs.length, 1);
});
