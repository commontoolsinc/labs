---
status: historical
created: 2026-07-14
archived: 2026-07-14
reason: "Paired Lunch Poll measurement of refs-first request-schema CAS across disabled, cold, and durable warm runs."
---

# Refs-first request-schema CAS: paired Lunch Poll measurement

## Question

Does optimistic refs-first request-schema CAS transmit a schema body only on a
genuine cold miss, remain warm across reconnects and server restarts, and improve
the real two-browser Lunch Poll request traffic?

## Method

The protocol behavior was first checked with deterministic Memory tests. A
file-backed schema store and captured canonical wire frames exercised this
ordered sequence:

1. cold refs-only query;
2. one forced-definition retry;
3. warm query;
4. warm schema-bearing watch;
5. warm query after reconnect and resumed subscription;
6. warm query from a fresh client;
7. warm query from a fresh client after server and schema-store reopen.

The test requires exactly one `schemaDefinitions` frame, at position 2, and
compares every raw UTF-8 payload with its exact `encodeMemoryBoundary` result.
It also compares each warm frame with the exact historical inline-schema form.
A separate concurrent test verifies that two in-flight store-admission failures
both fall back inline without looping or denying either operation.

The browser measurement then ran the same Lunch Poll integration workload three
times. Each initial configuration used an isolated Memory directory:

```sh
HEADLESS=1 \
  CF_MEMORY_REQUEST_SCHEMA_CAS_ENABLED=false \
  MEMORY_DIR=file:///tmp/opencode/lunch-cas-off-2/ \
  deno task integration patterns lunch-poll-vote

HEADLESS=1 \
  MEMORY_DIR=file:///tmp/opencode/lunch-cas-on-2/ \
  deno task integration patterns lunch-poll-vote

# Fresh server and clients, same durable CAS as the enabled run above.
HEADLESS=1 \
  MEMORY_DIR=file:///tmp/opencode/lunch-cas-on-2/ \
  deno task integration patterns lunch-poll-vote
```

All three complete two-user behavior runs passed. Accounting measured canonical
UTF-8 Memory websocket text payloads; websocket framing, compression, HTTP,
TLS, and TCP bytes were excluded.

## Results

### Whole browser workload

| Run | Same-run baseline | Actual bytes | Same-run saved | Browser connections |
| --- | ----------------: | -----------: | -------------: | ------------------: |
| CAS disabled, isolated store | 5,097,310 | 4,357,025 | 740,285 (14.5%) | 6 |
| CAS enabled, empty store | 5,552,801 | 4,470,842 | 1,081,959 (19.5%) | 6 |
| CAS enabled, durable warm restart | 5,061,912 | 3,902,919 | 1,158,993 (22.9%) | 6 |

The disabled run still benefits from outbound `syncSchemaTableV2`; its inbound
request classes remain byte-identical. Comparing actual traffic in the paired
disabled run with the durable warm run gives:

```text
4,357,025 -> 3,902,919 bytes
454,106 bytes lower (10.4%)
```

The browser workload is reactive, so frame counts vary with scheduling and
conflict retries. The paired totals are therefore supporting evidence rather
than a byte-for-byte golden. The disabled and durable-warm same-run baselines
differed by 35,398 bytes (0.7%), and their CAS-capable request counts were 496
and 481 respectively.

### Request uploads

| Run | Inline logical bytes | Actual request bytes | Saved |
| --- | -------------------: | -------------------: | ----: |
| CAS disabled | 1,427,966 | 1,427,966 | 0 (0.0%) |
| CAS enabled, empty store | 1,774,647 | 1,442,381 | 332,266 (18.7%) |
| CAS enabled, durable warm restart | 1,400,131 | 981,177 | 418,954 (29.9%) |

The durable warm request result is the clean same-run answer: request-schema
CAS removed 29.9% of the expanded logical request bytes. The earlier
definitions-first measurement recorded 12.7%, so refs-first durable reuse more
than doubled the observed request-side percentage in this workload.

The paired disabled-to-warm actual request comparison was
`1,427,966 -> 981,177`, 446,789 bytes (31.3%) lower, with the frame-count caveat
above. The enabled empty-store run sat between disabled and durable-warm as
expected. It included cold-miss error traffic; after restart against the same
schema store, the report contained no `server.response.session.watch.add.error`
classification.

## Interpretation

- The deterministic test proves the intended sequential contract: one canonical
  body on cold admission, then refs only across warm use, subscription resume,
  fresh clients, and durable server restart.
- The durable warm Lunch Poll run spent 29.9% fewer bytes on CAS-capable request
  uploads and 22.9% fewer bytes overall than its expanded same-run logical
  baseline.
- The paired physical runs support the same conclusion, but their total-byte
  delta must not be treated as an exact causal golden because the reactive
  workload emitted different numbers of retries.
- Concurrent cold clients can each reach a forced-definition retry. The store is
  hash-verified and idempotent, but global exactly-once body transfer would need
  additional coordination and is not claimed here.

## Limitations

- This is a point-in-time local integration measurement, not a fleet traffic
  model.
- The accounting unit excludes websocket framing, permessage-deflate, TLS, and
  transport headers.
- Setup occurs before browser accounting begins. The empty-store browser run can
  still encounter schemas not admitted by setup, while the repeated run is the
  deliberate durable-warm case.
- Exact transfer expectations live in deterministic protocol tests; browser
  tests assert behavior and accounting invariants because scheduling changes
  frame counts.
