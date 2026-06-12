# Scheduler v2 implementation — progress log

> Maintained by the implementing agent (rule G7 in `00-README.md`).
> One line per completed step; deviations, STOP events, and required
> recordings (bench numbers, red-test outputs, enumerated grep results)
> in full under the step's heading. The reviewer reads this file first.

Format:

```
## <work order>/<step>
- [x] <commit sha> — <one-line summary>
- Deviations: <none | description>
- Recordings: <bench numbers / red output excerpts / site lists, as the
  step requires>
```

## Baseline (fill in before work order 01)

- Branch + base commit:
- Full runner suite result (`cd packages/runner && deno task test`):
- Bench baseline (commands from 05/step-0, plus
  `scheduler-event-preflight.bench.ts`, `scheduler-materializer-fanout.bench.ts`,
  `scheduler-persistent-state.bench.ts`, `scheduler-pull-seeds.bench.ts`):
- `reload-rehydration.test.ts` rehydrate-miss counts:
