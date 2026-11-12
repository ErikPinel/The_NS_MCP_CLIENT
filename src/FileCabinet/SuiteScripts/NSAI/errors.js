/**
 * @NApiVersion 2.1
 */
define([], () => {
    function fail(code, message, status = 400) {
        const error = new Error(message);
        error.code = code;
        error.status = status;
        error.safe = true;
        throw error;
    }

    function publicError(error) {
        return error && error.safe === true
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL_ERROR', message: 'The request failed. Contact your NetSuite administrator.' };
    }

    return { fail, publicError };
});
