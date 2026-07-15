---
status: historical
created: 2026-07-14
archived: 2026-07-14
reason: "End-to-end Lunch Poll wire measurement after durable Memory request-schema CAS was implemented."
---

# Memory request-schema CAS: Lunch Poll measurement

## Question

How much browser-to-server Memory traffic does the durable request-schema CAS
remove in the real two-browser Lunch Poll flow, and does the combined request
CAS plus response sync table preserve the working behavior?

## Method

The successful measured command was:

```sh
deno task integration patterns lunch-poll-vote
```

The scenario exercised six browser Memory connections while two users joined a
poll, added options, cast concurrent votes, and observed the merged result in
both browsers. All behavior assertions passed.

Accounting measured canonical UTF-8 bytes in Memory websocket text payloads.
For CAS-capable inbound requests, baseline is the same logical request with
schemas expanded inline and actual is the negotiated request carrying
`schema-cas@1:` references plus any first-use `schemaDefinitions`. For outbound
sync-bearing frames, baseline is the expanded sync and actual is the negotiated
`syncSchemaTableV2` frame. Websocket framing, compression, HTTP upgrade, TLS,
and TCP bytes are excluded.

The Toolshed used one private durable SQLite schema store shared by Memory
connections. Clients scoped known hashes to the store generation and audience.
The server authorized requests before schema ingestion, verified canonical
tagged hashes, expanded every reference, rejected unused definitions, and
inserted each request's definitions atomically.

## Headline

| Browser connections | Baseline bytes | Actual bytes | Saved bytes | Saved |
| ------------------: | -------------: | -----------: | ----------: | ----: |
|                   6 |      5,064,382 |    4,151,185 |     913,197 | 18.0% |

## Request-side result

| Inbound class | Baseline bytes | Actual bytes | Saved bytes | Saved |
| ------------- | -------------: | -----------: | ----------: | ----: |
| `client.graph.query` | 1,615 | 2,300 | -685 | -42.4% |
| `client.session.watch.add` | 562,379 | 487,925 | 74,454 | 13.2% |
| `client.transact` | 860,956 | 754,279 | 106,677 | 12.4% |
| **CAS-capable inbound total** | **1,424,950** | **1,244,504** | **180,446** | **12.7%** |

First-use query frames grew because a small request pays the fixed reference and
definition envelope cost. Repeated watch and transaction schemas more than
recovered that cost. The live regression guard therefore allows individual CAS
frames to grow but requires the CAS-capable inbound aggregate to save bytes;
all non-CAS inbound classes remain byte-identical to baseline.

## Response-side result

| Outbound sync class | Baseline bytes | Actual bytes | Saved bytes | Saved |
| ------------------- | -------------: | -----------: | ----------: | ----: |
| `server.response.session.watch.add.sync` | 2,862,831 | 2,184,493 | 678,338 | 23.7% |
| `server.session/effect.sync` | 335,855 | 281,442 | 54,413 | 16.2% |
| **Sync-bearing outbound total** | **3,198,686** | **2,465,935** | **732,751** | **22.9%** |

The request CAS and existing response table savings sum to the 913,197-byte
overall reduction. Non-sync outbound classes remained byte-identical.

## Limitations

- This is a point-in-time workload measurement, not a fleet-wide traffic model.
- Exact totals vary with startup timing, retries, and browser activity; live
  tests assert semantic and aggregate invariants rather than these byte totals.
- The same-run baseline compares logical expanded and negotiated encodings. It
  is not a second physical run with protocol negotiation disabled.
- The result covers websocket text payloads, not physical network bytes.

## Conclusion

Durable request-schema CAS removed 12.7% of CAS-capable inbound request bytes in
this run. Combined with frame-local response schema tables, it reduced total
browser-scoped Memory payload bytes by 18.0% while the complete two-user Lunch
Poll behavior passed.
