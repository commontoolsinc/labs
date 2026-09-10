---
status: historical
created: 2026-08-15
archived: 2026-08-15
reason: "Benchmark snapshot for operation integration, query, checkpoint replay, and structured documents."
---

# Memory apply-op benchmark snapshot

Command:

```text
deno bench -A packages/memory/test/v2-operation.bench.ts
```

Environment: Deno 2.9.2, `aarch64-apple-darwin`. Each benchmark used one
measured iteration with fixture construction excluded from the timed region.
These measurements are diagnostic evidence and define no pass/fail threshold.

| Scenario | Average |
| --- | ---: |
| Apply one stale edit to 100 KB text over a 100-operation suffix | 1.7 ms |
| Query a 100-operation text suffix | 598.5 us |
| Verify a checkpoint, replay 50 text operations, and prune | 1.3 ms |
| Apply one operation to a 1,000-node synthetic structured document over a 100-operation suffix | 7.5 ms |

The benchmark source is
`packages/memory/test/v2-operation.bench.ts`. The structured case uses a
test-only codec and does not depend on a rich-text editor implementation.
