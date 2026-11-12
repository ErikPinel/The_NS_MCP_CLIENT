/**
 * @NApiVersion 2.1
 */
define(['N/runtime', './config', './errors'], (runtime, config, errors) => {
    function authorize() {
        const user = runtime.getCurrentUser();
        if (!(Number(user.id) > 0) ||
            !config.allowedRoleIds.map(String).includes(String(user.role))) {
            errors.fail('ACCESS_DENIED', 'Your current role is not enabled for NetSuite AI Chat.', 403);
        }
        return user;
    }

    function readOnlyQuery(query) {
        if (typeof query !== 'string' || query.length < 1 || query.length > 8000) {
            errors.fail('INVALID_QUERY', 'Provide a SELECT query of at most 8000 characters.');
        }
        const sql = query.replace(/'(?:''|[^'])*'|"(?:\"\"|[^"])*"/g, '0').toLowerCase();
        if (!/^\s*select\b/.test(sql) || /['";`\\?]/.test(sql) ||
            /--|\/\*|\*\//.test(sql) ||
            /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|execute|exec|call|begin|declare|into)\b/.test(sql)) {
            errors.fail('QUERY_DENIED', 'Only a single read-only SELECT is allowed; comments, bind placeholders and CTEs are not supported.');
        }
        let depth = 0;
        for (const character of sql) {
            if (character === '(') {
                depth += 1;
            } else if (character === ')') {
                depth -= 1;
                if (depth < 0) {
                    errors.fail('INVALID_QUERY', 'The query has unbalanced parentheses.');
                }
            }
        }
        if (depth !== 0) {
            errors.fail('INVALID_QUERY', 'The query has unbalanced parentheses.');
        }
        return query;
    }

    return { authorize, readOnlyQuery };
});
