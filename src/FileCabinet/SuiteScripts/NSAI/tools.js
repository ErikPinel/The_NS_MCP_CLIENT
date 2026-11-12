/**
 * @NApiVersion 2.1
 */
define(['N/query', 'N/record', 'N/search', 'N/runtime', 'N/log', './config', './policy', './errors'],
    (query, record, search, runtime, log, config, policy, errors) => {
        const objectSchema = properties => ({
            type: 'object', properties, required: Object.keys(properties), additionalProperties: false
        });
        const typeSchema = {
            type: 'string', minLength: 1, maxLength: 200,
            description: 'NetSuite internal record/search type, including customrecord_* types. NetSuite validates the type and permissions.'
        };
        const fieldsSchema = {
            type: ['array', 'null'], items: { type: 'string', minLength: 1, maxLength: 200 },
            minItems: 1, maxItems: 10
        };
        const limitSchema = { type: ['integer', 'null'], minimum: 1, maximum: config.maxRows };

        function recordType(value) {
            if (typeof value !== 'string' || !value.trim() || value.length > 200) {
                errors.fail('INVALID_RECORD_TYPE', 'Provide a NetSuite internal record/search type of 1-200 characters.');
            }
            return value;
        }

        function selectedFields(value) {
            if (value === null) {
                return null;
            }
            if (!Array.isArray(value) || value.length < 1 || value.length > 10 ||
                value.some(field => typeof field !== 'string' || !field.trim() || field.length > 200)) {
                errors.fail('INVALID_FIELDS', 'Provide null or 1-10 NetSuite field names of 1-200 characters each.');
            }
            return value;
        }

        function limit(value) {
            if (value === null) {
                return 25;
            }
            if (!Number.isInteger(value) || value < 1 || value > config.maxRows) {
                errors.fail('INVALID_LIMIT', `Limit must be between 1 and ${config.maxRows}.`);
            }
            return value;
        }

        const registry = {
            execute_suiteql: {
                description: 'Execute a single read-only SELECT against any tables and columns available to the current NetSuite execution role. ' +
                    'NetSuite validates table/column access, joins, subqueries and functions such as BUILTIN.DF. ' +
                    'No comments, CTEs, bind placeholders or multiple statements. Returned rows are capped.',
                parameters: objectSchema({
                    query: { type: 'string' },
                    limit: limitSchema
                }),
                budget: 20,
                maxCalls: 4,
                execute(args) {
                    const sql = policy.readOnlyQuery(args.query);
                    const count = limit(args.limit);
                    const rows = query.runSuiteQL({
                        query: `SELECT * FROM (${sql}) WHERE ROWNUM <= ?`,
                        params: [count + 1],
                        metaDataProvider: 'SUITE_QL'
                    }).asMappedResults();
                    return { rows: rows.slice(0, count), truncated: rows.length > count };
                }
            },
            get_record: {
                description: 'Retrieve body fields from any NetSuite-supported record type, including custom records. ' +
                    'NetSuite enforces access when the record is loaded. No sublists or attachments. ' +
                    'Prefer explicit fields to avoid oversized results.',
                parameters: objectSchema({
                    type: typeSchema,
                    id: { type: 'string', description: 'Positive numeric internal record ID.' },
                    fields: {
                        ...fieldsSchema,
                        description: 'Requested body field IDs, or null for all body fields returned by NetSuite. Large results fail; retry with specific fields.'
                    }
                }),
                budget: 20,
                maxCalls: 6,
                execute(args) {
                    const type = recordType(args.type);
                    const requestedFields = selectedFields(args.fields);
                    if (typeof args.id !== 'string' || !/^[1-9]\d{0,14}$/.test(args.id)) {
                        errors.fail('INVALID_ID', 'Provide a positive numeric internal record ID.');
                    }
                    const loaded = record.load({ type, id: args.id, isDynamic: false });
                    const fields = requestedFields === null ? loaded.getFields() : requestedFields;
                    const values = Object.create(null);
                    fields.forEach(field => { values[field] = loaded.getValue({ fieldId: field }); });
                    return { type, id: String(loaded.id), fields: values };
                }
            },
            search_records: {
                description: 'Search any NetSuite-supported search type with AND-combined, non-joined field filters. ' +
                    'NetSuite enforces record and field access when the search runs. ' +
                    'Sales order and invoice searches automatically select main lines; for other transaction types request a mainline filter if needed.',
                parameters: objectSchema({
                    type: typeSchema,
                    filters: {
                        type: 'array',
                        maxItems: 8,
                        items: objectSchema({
                            field: { type: 'string' },
                            operator: { type: 'string', enum: ['is', 'contains', 'startswith', 'anyof', 'equalto', 'greaterthan', 'lessthan', 'onorafter', 'onorbefore'] },
                            values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }
                        })
                    },
                    fields: {
                        ...fieldsSchema,
                        description: 'Requested NetSuite search column names, or null to return record IDs only. Use SuiteQL for joins.'
                    },
                    limit: limitSchema
                }),
                budget: 20,
                maxCalls: 6,
                execute(args) {
                    const type = recordType(args.type);
                    const fields = selectedFields(args.fields) || [];
                    const count = limit(args.limit);
                    if (!Array.isArray(args.filters) || args.filters.length > 8) {
                        errors.fail('INVALID_FILTERS', 'Provide at most eight field filters.');
                    }
                    const operators = registry.search_records.parameters.properties.filters.items.properties.operator.enum;
                    const filters = args.filters.map(filter => {
                        validateKeys(filter, ['field', 'operator', 'values']);
                        selectedFields([filter.field]);
                        if (!operators.includes(filter.operator) || !Array.isArray(filter.values) ||
                            filter.values.length < 1 || filter.values.length > 20 ||
                            filter.values.some(value => typeof value !== 'string' || value.length > 200)) {
                            errors.fail('INVALID_FILTERS', 'A search filter has an invalid operator or values.');
                        }
                        return search.createFilter({ name: filter.field, operator: filter.operator, values: filter.values });
                    });
                    if (type === 'salesorder' || type === 'invoice') {
                        filters.push(search.createFilter({ name: 'mainline', operator: 'is', values: ['T'] }));
                    }
                    const results = search.create({
                        type,
                        filters,
                        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })].concat(fields)
                    }).run().getRange({ start: 0, end: count + 1 });
                    return {
                        rows: results.slice(0, count).map(result => {
                            const values = Object.create(null);
                            fields.forEach(field => { values[field] = result.getValue({ name: field }); });
                            return { id: String(result.id), fields: values };
                        }),
                        truncated: results.length > count
                    };
                }
            },
            get_account_info: {
                description: 'Get account ID, environment, NetSuite version and current user/role IDs. No credentials or company configuration.',
                parameters: objectSchema({}),
                budget: 1,
                maxCalls: 2,
                execute() {
                    const user = policy.authorize();
                    return {
                        accountId: runtime.accountId, environment: runtime.envType,
                        version: runtime.version, userId: String(user.id), roleId: String(user.role)
                    };
                }
            }
        };

        function validateKeys(value, keys) {
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                keys.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
                Object.keys(value).some(key => !keys.includes(key))) {
                errors.fail('INVALID_ARGUMENTS', 'Tool arguments must match the declared schema exactly.');
            }
        }

        function schemas() {
            return Object.keys(registry).map(name => ({
                type: 'function', name, description: registry[name].description,
                parameters: registry[name].parameters, strict: true
            }));
        }

        function execute(name, serializedArgs, context) {
            try {
                policy.authorize();
                if (!Object.prototype.hasOwnProperty.call(registry, name)) {
                    errors.fail('UNKNOWN_TOOL', 'The requested tool is not registered.');
                }
                const tool = registry[name];
                context.toolCalls += 1;
                context.callsByTool[name] = (context.callsByTool[name] || 0) + 1;
                if (context.toolCalls > config.maxToolCalls || context.callsByTool[name] > tool.maxCalls ||
                    Date.now() + config.requestReserveMs + 10000 >= context.deadline ||
                    runtime.getCurrentScript().getRemainingUsage() < config.governanceReserve + tool.budget) {
                    context.stopTools = true;
                    errors.fail('TOOL_BUDGET_EXCEEDED', 'Tool execution stopped to preserve time or governance for the final answer.');
                }
                let args;
                try {
                    args = JSON.parse(serializedArgs);
                } catch (error) {
                    errors.fail('INVALID_ARGUMENTS', 'Tool arguments are not valid JSON.');
                }
                validateKeys(args, Object.keys(tool.parameters.properties));
                const usageBefore = runtime.getCurrentScript().getRemainingUsage();
                const result = tool.execute(args);
                if (usageBefore - runtime.getCurrentScript().getRemainingUsage() > tool.budget) {
                    context.stopTools = true;
                    errors.fail('TOOL_BUDGET_EXCEEDED', 'The tool exceeded its governance budget.');
                }
                const output = JSON.stringify({ ok: true, result });
                if (output.length > config.maxToolOutputChars) {
                    errors.fail('RESULT_TOO_LARGE', 'The result is too large. Request fewer rows or fields.');
                }
                return output;
            } catch (error) {
                const code = error.code || error.name;
                log.error({ title: 'NSAI tool rejected or failed', details: JSON.stringify({ tool: name, code }) });
                const permissionDenied = ['INSUFFICIENT_PERMISSION', 'INSUFFICIENT_PERMISSIONS',
                    'PERMISSION_VIOLATION', 'SSS_PERMISSION_VIOLATION', 'SUITE_QL_PERMISSION_VIOLATION'].includes(code);
                return JSON.stringify({
                    ok: false,
                    error: permissionDenied
                        ? { code: 'NETSUITE_PERMISSION_DENIED', message: 'NetSuite denied this tool request under the current execution role. Check the role permissions and record restrictions.' }
                        : errors.publicError(error)
                });
            }
        }

        return { schemas, execute };
    });
