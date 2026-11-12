/**
 * @NApiVersion 2.1
 * @NScriptType Portlet
 */
define(['N/url', 'N/log', './policy', './html', './errors'], (url, log, policy, html, errors) => {
    function render(context) {
        context.portlet.title = 'NetSuite AI Chat';
        try {
            policy.authorize();
            const endpoint = url.resolveScript({
                scriptId: 'customscript_nsai_controller',
                deploymentId: 'customdeploy_nsai_controller',
                returnExternalUrl: false
            });
            context.portlet.html = `<iframe title="NetSuite AI Chat" src="${html.escape(endpoint)}" ` +
                'style="width:100%;height:520px;border:0" referrerpolicy="same-origin"></iframe>';
        } catch (error) {
            log.error({ title: 'NSAI portlet failed', details: error.code || error.name || 'INTERNAL_ERROR' });
            context.portlet.html = `<p role="alert">${html.escape(errors.publicError(error).message)}</p>`;
        }
    }

    return { render };
});
