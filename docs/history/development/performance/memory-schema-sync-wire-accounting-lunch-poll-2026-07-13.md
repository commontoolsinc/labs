---
status: historical
created: 2026-07-13
archived: 2026-07-13
reason: "Performance report for the July 13, 2026 Lunch Poll Memory schema-sync wire-accounting runs."
---

# Memory schema-sync wire accounting: Lunch Poll runs

This report records two successful July 13, 2026 runs of the real two-browser
Lunch Poll vote flow, measured with Memory websocket wire accounting. The live
debugging entry is
[`docs/development/debugging/README.md`](../../../development/debugging/README.md#runtime-inspection).

## Measured unit

The unit is UTF-8 bytes of Memory websocket text payloads produced by
`encodeMemoryBoundary`, as recorded by
[`packages/memory/v2/wire-accounting.ts`](../../../../packages/memory/v2/wire-accounting.ts)
and [`packages/memory/v2/server.ts`](../../../../packages/memory/v2/server.ts).
The numbers do not include HTTP upgrade bytes, websocket framing or masking,
ping/pong/close frames, permessage-deflate physical bytes, TLS, or TCP. They are
not claims about total physical network-wire bytes.

## Methodology

The scenario was `deno task integration patterns lunch-poll-vote`, which runs
[`packages/patterns/integration/lunch-poll-vote.test.ts`](../../../../packages/patterns/integration/lunch-poll-vote.test.ts)
against a Toolshed started by the root integration runner. The runner generated
a random `CF_MEMORY_WIRE_ACCOUNTING_TOKEN` and passed it to both Toolshed and
the test process. Toolshed exposed
`/api/storage/memory/wire-accounting/{start,stop}` only because a token was
configured and `ENV` was a development/test value.

Accounting started before both browsers navigated and stopped after the final
runtime-idle barrier. The Lunch Poll report code filtered the raw Memory report
to browser connections and printed aggregate plus per-direction,
per-classification tables.

The baseline is a same-run counterfactual. For outbound frames, baseline bytes
encode the original uncompressed `ServerMessage`; actual bytes encode the
message sent after negotiated `syncSchemaTableV2` compression. For inbound
frames, baseline equals actual. This compares two encodings observed in one run,
not two separate noisy runs.

## Results

Both runs completed the behavior checks: two users cast concurrent green votes
on the same option, both votes survived, and the resulting tally propagated to
both browsers. A second option then tallied independently.

| Run | Browser connections | Baseline bytes | Actual bytes | Saved bytes | Saved |
| --- | ------------------: | -------------: | -----------: | ----------: | ----: |
| 1   |                   6 |      5,048,753 |    4,309,247 |     739,506 | 14.6% |
| 2   |                   6 |      5,092,459 |    4,347,108 |     745,351 | 14.6% |

Run 2 also recorded 1,129 total Memory frames in the browser-scoped analysis.

The exact aggregate totals are intentionally not asserted by the test. The test
asserts invariants instead: accounting records browser frames, baseline and
actual browser connection sets match, inbound classes are byte-identical,
outbound non-sync classes are byte-identical, sync-bearing outbound classes save
bytes, and the sync-bearing outbound savings floor is a conservative 15%.

## Run 2 class evidence

Only sync-bearing outbound classes changed in Run 2.

| Direction | Classification                           | Baseline bytes | Actual bytes | Saved bytes | Saved |
| --------- | ---------------------------------------- | -------------: | -----------: | ----------: | ----: |
| outbound  | `server.response.session.watch.add.sync` |      2,864,047 |    2,185,840 |     678,207 | 23.7% |
| outbound  | `server.session/effect.sync`             |        381,775 |      314,631 |      67,144 | 17.6% |

All inbound classifications and all outbound non-sync classifications had
identical baseline and actual byte totals. The accounting classifications are
the Memory protocol message classes recorded by `classifyClientMessage` and
`classifyServerMessage`, for example `client.<type>`, `server.hello.ok`,
`server.session/effect.sync`, and `server.response.<origin>.sync`.

## Limitations

- The measurement covers browser-scoped Memory websocket text payload bytes
  only. Runtime/server connections can exist in the raw report but are excluded
  from the Lunch Poll analysis.
- The baseline is an accounting counterfactual inside one run. It is useful for
  comparing schema-table encodings, but it is not a replay of a fully separate
  uncompressed scenario.
- Per-run totals can drift with unrelated traffic, startup timing, and browser
  behavior. That is why the test keeps exact totals out of live assertions.
- Remaining actual bytes are dominated by protocol classes this schema-table
  encoding does not change.

## Conclusion

The schema-sync encoding reduced browser-scoped Memory text payload bytes by
14.6% overall in both measured Lunch Poll runs, while the affected outbound sync
classes saved 23.7% and 17.6% in Run 2. The behavior checks passed, so the
measurement captured a working two-user flow rather than a broken fast path. The
live regression guard should remain invariant-based, with the conservative 15%
sync-bearing outbound floor, rather than pinning these July 13 aggregate totals.
