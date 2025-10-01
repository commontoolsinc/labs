import { cell, derive, lift } from "commontools";

const stage = cell<string>("initial");
const attemptCount = cell<number>(0);
const acceptedCount = cell<number>(0);
const rejectedCount = cell<number>(0);

const normalizedStage = lift((value: string) => value)(stage);
const attempts = lift((count: number) => count)(attemptCount);
const accepted = lift((count: number) => count)(acceptedCount);
const rejected = lift((count: number) => count)(rejectedCount);

const summary = derive(
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
