/**
 * @NApiVersion 2.1
 */
define([], () => ({
    model: 'gpt-6-luna',
    secretId: 'custsecret_nsai_openai',
    // Enable only when the API model supports reasoning summaries.
    reasoningSummary: false,
    // Explicitly opt in internal roles after approving data transfer to OpenAI.
    allowedRoleIds: [3],
    maxLlmRequests: 5,
    maxToolCalls: 12,
    maxRows: 100,
    maxMessageChars: 4000,
    maxToolOutputChars: 16000,
    maxConversationChars: 100000,
    maxTurns: 12,
    maxOutputTokens: 1800,
    maxElapsedMs: 240000,
    requestReserveMs: 60000,
    governanceReserve: 80,
    sessionTtl: 3600
}));
