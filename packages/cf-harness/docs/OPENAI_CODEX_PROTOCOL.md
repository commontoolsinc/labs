# OpenAI Codex subscription protocol reference

This file pins the direct OAuth and ChatGPT Codex Responses contract used by
`cf-harness`. It is a compatibility reference, not a general OpenAI API
contract. Update it together with fixtures when either upstream implementation
changes.

Reviewed sources:

- OpenCode `411eff73f026d4950c07947c4d983788cb615baa`,
  `packages/opencode/src/plugin/openai/codex.ts`
- pi `9b3a2059171bcc74ad9d2cadeea6d186776cf2db`,
  `packages/ai/src/auth/oauth/openai-codex.ts` and
  `packages/ai/src/api/openai-codex-responses.ts`
- official Codex `88f1cd9664d09b68909a258a061a662c1f099ce6`
- [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)

## Pinned OAuth contract

- Client id: `app_EMoamEEZ73f0CkXaXp7hrann`
- Issuer: `https://auth.openai.com`
- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token`
- Scope: `openid profile email offline_access`
- Browser redirect: `http://localhost:1455/auth/callback`
- Authorization parameters: `response_type=code`, PKCE `S256`, state,
  `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and
  `originator=cf-harness`
- Device start: `/api/accounts/deviceauth/usercode`
- Device poll: `/api/accounts/deviceauth/token`
- Device verification: `/codex/device`
- Device token-exchange redirect: `/deviceauth/callback`
- Account id claim: object key `https://api.openai.com/auth`, nested field
  `chatgpt_account_id`

Authorization-code exchange sends `grant_type`, `client_id`, `code`,
`code_verifier`, and `redirect_uri` as form data. Refresh sends
`grant_type=refresh_token`, `refresh_token`, and `client_id`. A refresh response
may rotate the refresh token and must be persisted atomically. Every OAuth and
Codex API fetch rejects HTTP redirects so credential-bearing bodies, account
headers, and prompts cannot leave the pinned origins.

## Pinned Responses contract

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Required request headers: bearer authorization, `chatgpt-account-id`,
  `originator: cf-harness`, `accept: text/event-stream`, and
  `content-type: application/json`
- Session affinity: the stable harness run id is sent as `session-id`,
  `x-client-request-id`, and `prompt_cache_key`
- Request invariants: `store: false`, `stream: true`,
  `include: ["reasoning.encrypted_content"]`, `tool_choice: "auto"`, and
  `parallel_tool_calls: true`; text verbosity is `low` and function schemas are
  passed through unchanged with `strict: null`
- Tool continuation retains both the public call id and provider function-item
  id, so the corresponding `function_call_output` remains paired after resume.
- The first transport is SSE. WebSockets, transparent retries, endpoint probing,
  and client-id fallback are not implemented.

Provider-scoped model discovery uses only
`https://chatgpt.com/backend-api/codex/models?client_version=0.0.0`. It sends
the same bearer/account/originator identity and accepts only the canonical
top-level `models` array. Entries remain in provider order and retain advertised
input, reasoning, and parallel-tool capabilities. Model metadata is not cached
by this first implementation.

The response adapter accepts `response.completed`, `response.done`,
`response.incomplete`, and `response.failed` terminal event spellings because
the compared clients normalize those terminal forms. It persists encrypted
reasoning output items only as provider-tagged opaque continuation state.

## Product boundary

The local filesystem credential adapter is keyed to a local owner. Loom must
inject an authenticated owner/tenant key and store that owner's credential in
its encrypted secret backend. Tokens and account ids never belong in Cells,
Spaces, manifests, transcripts, reports, diagnostics, or command lines.

OAuth material is sent only to `https://auth.openai.com` (authorization, device
authorization, and token exchange), the fixed loopback callback
`http://localhost:1455/auth/callback` (the browser redirects the authorization
code and state), and `https://chatgpt.com` (Codex Responses and model
discovery). The implementation does not probe alternatives. On drift, update
this reference and its fixtures from newly pinned OpenCode, pi, and official
Codex sources; until then, fail closed.
