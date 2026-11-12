/**
 * @NApiVersion 2.1
 */
define(['N/cache', 'N/crypto/random', './config', './errors'], (cache, random, config, errors) => {
    function store() {
        return cache.getCache({ name: 'nsai_conversations', scope: cache.Scope.PRIVATE });
    }

    function key(user, id) {
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
            errors.fail('INVALID_SESSION', 'Invalid chat session. Start a new chat.');
        }
        return `${user.id}:${user.role}:${id}`;
    }

    function save(user, state) {
        store().put({ key: key(user, state.id), value: JSON.stringify(state), ttl: config.sessionTtl });
    }

    function create(user) {
        const state = {
            id: random.generateUUID(),
            token: random.generateUUID(),
            revision: 0,
            history: [],
            busy: false,
            expiresAt: Date.now() + config.sessionTtl * 1000
        };
        save(user, state);
        return state;
    }

    function load(user, request) {
        const serialized = store().get({ key: key(user, request.id) });
        if (!serialized) {
            errors.fail('SESSION_EXPIRED', 'This chat expired or was evicted from cache. Start a new chat.', 410);
        }
        const state = JSON.parse(serialized);
        if (state.expiresAt <= Date.now()) {
            errors.fail('SESSION_EXPIRED', 'This chat expired. Start a new chat.', 410);
        }
        if (typeof request.token !== 'string' || state.token !== request.token) {
            errors.fail('INVALID_TOKEN', 'The chat security token is invalid. Reload this chat.', 403);
        }
        if (!Number.isInteger(request.revision) || state.revision !== request.revision || state.busy) {
            errors.fail('SESSION_CONFLICT', 'Another message is in progress or this chat is out of date. Start a new chat.', 409);
        }
        if (state.history.length >= config.maxTurns * 2) {
            errors.fail('TURN_LIMIT', 'This chat reached its turn limit. Start a new chat.', 409);
        }
        return state;
    }

    return { create, load, save };
});
