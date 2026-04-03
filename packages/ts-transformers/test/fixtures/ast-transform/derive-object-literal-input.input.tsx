/// <cts-enable />
import { cell, derive, lift } from "commonfabric";

const stage = cell<string>("initial");
const attemptCount = cell<number>(0);
const acceptedCount = cell<number>(0);
const rejectedCount = cell<number>(0);

// FIXTURE: derive-object-literal-input
// Verifies: cell(), lift(), and derive() all get schemas injected from type annotations
//   cell<string>("initial")             → cell<string>("initial", { type: "string" })
//   lift((value: string) => value)      → lift(inputSchema, outputSchema, fn)
//   derive({ stage, ... }, fn)          → derive(inputSchema, outputSchema, { stage, ... }, fn)
// Context: No export default; first export-relevant statement is the cells/lifts/derive at top level
const normalizedStage = lift((value: string) => value)(stage);
const attempts = lift((count: number) => count)(attemptCount);
const accepted = lift((count: number) => count)(acceptedCount);
const rejected = lift((count: number) => count)(rejectedCount);

const _summary = derive(
  {
    stage: normalizedStage,
    attempts: attempts,
    accepted: accepted,
    rejected: rejected,
  },
  (snapshot) =>
    `stage:${snapshot.stage} attempts:${snapshot.attempts}` +
    ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`,
);
