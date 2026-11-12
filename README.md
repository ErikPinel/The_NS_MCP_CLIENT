# NetSuite-native AI Chat

A SuiteScript 2.1 dashboard Portlet embeds an internal Suitelet. The Suitelet calls
the OpenAI Responses API and dispatches tools directly to SuiteScript functions.
There is no MCP transport, additional server, OAuth hop, or client-side API key.

## Setup

1. Enable Server SuiteScript and SuiteCloud Development Framework in the account.
2. Before enabling users, approve sending their messages and retrieved account data
   to OpenAI under your organization's data-handling policy. `store: false` disables
   Responses API application storage; it is **not** a guarantee of zero data retention.
3. Create an OpenAI API secret at **Setup > Company > Preferences > API Secrets**:
   - Script ID: `custsecret_nsai_openai`.
   - Restrict to script `customscript_nsai_controller`.
   - Restrict to domain `api.openai.com`.
   - Restrict employee access to the intended users. Do not enable all scripts/domains.
   - Put the API key only in the secret's password field, never in source or logs.
4. In [config.js](src/FileCabinet/SuiteScripts/NSAI/config.js), set `allowedRoleIds`
   to the numeric internal role IDs, as strings, that may use this agent. This is
   only a chat admission gate, not a record-access policy. Record, field and table
   access are delegated to NetSuite. Review the model and execution budgets there.
   The model string must be an OpenAI API model ID available to your project.
5. From this project directory, with SuiteCloud CLI and Java installed:

   ```powershell
   npm test
   suitecloud project:validate
   suitecloud project:validate --server
   suitecloud project:deploy
   ```

   The existing local SuiteCloud authentication configuration is used. Deployment
   is a separate, intentional step; validation does not deploy this application.
6. Both deployments start in **Testing** with no public/external access. Test as
   the script owner, using an explicitly enabled role. On both deployments leave
   **Execute As Role** at **Current Role**, never Administrator or another elevated
   role. To release, set status to **Released** and select only the approved internal
   audience on both deployments. Match that audience to `allowedRoleIds`.
7. On the dashboard choose **Personalize > Custom Portlet**, then **Set Up** and
   select **NetSuite AI Chat Portlet**. The Suitelet deployment URL also opens chat
   directly.

Role IDs, the secret value, release status and audience are intentionally not
populated with account-specific values in the SDF objects.

## Tools and safeguards

| Tool | Scope | Per-request call limit | Governance budget per call |
| --- | --- | --- | --- |
| `execute_suiteql` | Read-only SELECT against any NetSuite-accessible tables/columns | 4 | 20 |
| `get_record` | Any NetSuite-supported record type and body fields; no sublists or attachments | 6 | 20 |
| `search_records` | Any NetSuite-supported search type and fields; bounded AND filters | 6 | 20 |
| `get_account_info` | Account/environment and current user/role IDs | 2 | 1 |

- Five **LLM requests**, not five tools: all function calls in one response are
  handled sequentially in process. The fifth request has `tool_choice: "none"`.
  An earlier final-only request is used when time, governance or tool limits demand it.
- Twelve total tool invocations, at most 100 rows per query/search, and 16,000
  characters per tool output. Oversized results return an explicit error; the agent
  can retry with a narrower request. Every tool checks its budget and authorization.
- There are no application-maintained record-type, field, table or permission
  allowlists and no `getPermission` prechecks. NetSuite's native record/search/query
  APIs determine data access using the execution role. SuiteQL uses
  `metaDataProvider: "SUITE_QL"` so permission failures are not silently masked.
  Keep both deployments on **Current Role**, since elevated execution would change
  which data NetSuite permits. Native permission failures are returned as tool
  errors; their raw messages and record values are not exposed in logs.
- Explicit field lists accept up to ten field names. For `get_record`, `fields:
  null` requests all body fields returned by `record.getFields()`; an oversized
  result fails explicitly and must be retried with selected fields. For
  `search_records`, `fields: null` returns IDs only. These are output-shape choices,
  not access allowlists. Custom records and custom fields need no configuration.
- Search filters are AND-combined and non-joined. Sales orders and invoices retain
  automatic `mainline = T`; other transaction searches should request a mainline
  filter explicitly when needed. Use SuiteQL for joins.
- SQL stays read-only: a single SELECT, no writes, multiple statements, comments,
  bind placeholders or CTEs. Joins, subqueries, quoted identifiers, transactions,
  custom-record tables and supported functions such as `BUILTIN.DF` are passed to
  NetSuite for validation rather than checked against local access lists.
- A 240-second application budget reserves 60 seconds before starting another
  HTTPS request, below the Suitelet's 300-second execution limit. Native HTTPS
  timeouts and governance may end a request earlier. There are no automatic
  retries that could multiply latency or charges.
- API errors, denied tools, incomplete model responses and expired sessions are
  reported explicitly. Logs contain codes/tool names, not prompts, record values,
  API response bodies, session tokens or API keys. Suitelet JSON errors carry
  `ok: false`, `error` and a logical `status`; the UI does not rely on a mutable
  HTTP status, which Suitelet's response API does not expose.

## OpenAI HTTP 429 troubleshooting

HTTP 429 alone does not distinguish an exhausted API quota from temporary
rate limiting. The adapter now reads only recognized error codes/types and
displays the appropriate action; it never exposes or logs raw provider messages.

- **API quota unavailable** (`insufficient_quota` or `billing_hard_limit_reached`):
  check [API billing and credits](https://platform.openai.com/settings/organization/billing/overview)
  and usage limits for the organization/project that owns the API key. A ChatGPT
  subscription does not provide API credits. Waiting or repeatedly retrying does
  not fix exhausted credits.
- **Temporarily rate-limited** (`rate_limit_exceeded`): wait before retrying, reduce
  concurrent usage, and check the project's request/token limits under
  [API limits](https://platform.openai.com/settings/organization/limits).
- **Unclassified 429**: the provider did not return a recognized code/type. Check
  both billing/credits and rate limits rather than assuming either cause.

There are no automatic retries inside the Suitelet. These diagnostic changes must
be deployed before the live chat will show the more specific error.

## Per-turn run details

Each submitted question and its answer or error have their own **Run details**
panel, collapsed by default:

- **Tool history** shows the function name, call ID, originating model request,
  arguments, shortened returned result, status, duration and governance used.
- **LLM history** shows each model request, model name, tool-choice mode, offered
  tools, input/output previews, HTTP status, token usage when supplied, and safe
  error details.
- **Thinking summaries / activity** shows provider-supplied public reasoning
  summaries when available and the actual sequence of model/tool activity. It
  never presents inferred thoughts or hidden chain-of-thought.

Previews are bounded: 1,200 characters per tool argument/result or reasoning
summary; 4,000 characters for each model input/output history preview, sampling
the latest eight items. Truncation and omitted items are labeled. At most
`maxToolCalls + 1` tool events are shown, with additional attempts counted.
Full tool results still go to the model within the existing result/context limits;
these preview limits do not alter tool execution or model context.

Set `reasoningSummary: true` in [config.js](src/FileCabinet/SuiteScripts/NSAI/config.js)
only if the selected API model supports Responses API reasoning summaries. This
requests `reasoning.summary: "auto"` and encrypted reasoning for stateless
continuation. It defaults to `false` to preserve compatibility with models that
do not support those options. Encrypted reasoning and non-summary reasoning
content are never included in browser traces, even when returned by the API.
If no public summary is supplied, the panel explicitly says so and shows activity.

Details arrive with the completed Suitelet response; this is not live streaming.
Failed turns retain any trace collected before the failure. A connection failure
cannot provide a server trace and is labeled accordingly. Each panel stays with
its own turn while the page is open; refresh/New chat clears it. Traces are not
stored in the conversation cache, sent back as model context, or written to
NetSuite logs. They may contain account-data previews visible to the current user,
but never request headers, the API secret, session tokens or raw API error bodies.

## Conversation behavior

Conversations live in private `N/cache`, keyed by current user, role and a random
session ID. A separate random CSRF token is required for POST. The browser sends
only the new message and session metadata, never trusted history. The UI renders
all messages as text rather than HTML.

Chats expire after an hour of inactivity or earlier cache eviction; refreshing or
**New chat** starts a fresh session. At most twelve complete turns and 100,000
characters of model input/history are allowed. Tool traces remain available during
the current tool loop, but only complete user/assistant text turns persist. A
follow-up requiring exact records must retrieve them again.

The UI permits one in-flight request. Server-side busy/revision checks reject
ordinary duplicate or stale submissions, but `N/cache` is **not** an atomic lock
or durable database. Do not share session metadata or build concurrent clients
against a single chat. On an uncertain network failure, start a new chat. A hard
NetSuite timeout may leave a session busy until it is discarded.

## Verification

`npm test` uses Node's built-in runner and mocked NetSuite AMD modules, with no npm
dependencies. It exercises the real controller, agent, secure header construction,
tool registry, native-permission delegation, read-only SQL, result budgets and session lifecycle.
Trace tests cover per-turn isolation, bounded previews, failed-request diagnostics,
reasoning-summary-only projection and text-only rendering of untrusted content.
SuiteCloud validation verifies SDF definitions separately.

After deployment, verify in a sandbox using approved test data:

- The Portlet loads and a normal message returns an answer.
- A request needing multiple tools returns matching results without another server.
- A restricted role cannot retrieve records it cannot open directly in NetSuite.
- Standard/custom records, fields and tables reach the native APIs without local
  allowlists; permission-denied requests surface NetSuite errors.
- SQL writes and write requests cannot modify data.
- Missing secret access, HTTP errors and expired sessions show actionable errors.
- Refresh/New chat, Enter/Shift+Enter and a multi-turn conversation work.

Actual account permissions, API-secret restrictions, model availability and live
OpenAI connectivity require this account-side smoke test; local mocks and SDF
validation alone cannot establish them.

## Oracle references

- [SDF XML reference](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml.html)
- [Suitelet](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml_3243071555.html)
  and [Portlet](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml_320447915.html)
- [Creating API secrets](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_160216498405.html)
- [Secure authentication headers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/subsect_162334564716.html)
- [HTTPS POST timeouts](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4567628658.html)
