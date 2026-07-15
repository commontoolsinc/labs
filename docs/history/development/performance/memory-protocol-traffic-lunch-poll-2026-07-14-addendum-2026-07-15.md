---
status: historical
created: 2026-07-15
archived: 2026-07-15
reason: "Reproducibility and accounting-scope addendum for the July 14, 2026 Lunch Poll Memory traffic measurement."
---

# Addendum: July 14 Lunch Poll Memory traffic measurement

This addendum preserves two details omitted or stated too narrowly in
[`memory-protocol-traffic-lunch-poll-2026-07-14.md`](memory-protocol-traffic-lunch-poll-2026-07-14.md).
The original report and its byte totals remain frozen.

## Reproduction configuration

The 14.6% measurement used inline request schemas while measuring the negotiated
`syncSchemaTableV2` representation of outbound sync payloads. On a checkout where
request-schema CAS defaults to enabled, the equivalent command is:

```sh
CF_MEMORY_REQUEST_SCHEMA_CAS_ENABLED=false \
  deno task integration patterns lunch-poll-vote
```

Without that startup override, the integration test also negotiates
`requestSchemaCasV1`, so it does not reproduce the recorded request frames.

## Accounting scope

The same-run comparison encoded each logical Memory message twice: `baseline`
was the fully expanded logical message and `actual` was its negotiated wire
form. `syncSchemaTableV2` describes the representation used for outbound sync
payloads; the headline also included inbound watch and transact requests plus
outbound non-sync responses. Physical websocket framing, permessage-deflate,
HTTP upgrade, TLS, and TCP bytes remained excluded.
