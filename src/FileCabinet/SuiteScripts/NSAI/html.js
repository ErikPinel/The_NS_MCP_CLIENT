/**
 * @NApiVersion 2.1
 */
define(['N/file'], file => {
    function escape(value) {
        return String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function render(bootstrap) {
        const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        return file.load({ id: 'SuiteScripts/NSAI/chat.html' }).getContents()
            .replace('__NSAI_BOOTSTRAP__', () => json);
    }

    return { escape, render };
});
