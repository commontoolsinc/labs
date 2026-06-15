import type { CountBucket, KeyedRecord } from "./keyed-collection-v1.ts";

export const LATEST_BY_COUNT_DELTA_V1_KIND = "latestByCountDelta@1";

export type LatestByCountDeltaV1Kind = typeof LATEST_BY_COUNT_DELTA_V1_KIND;

export type LatestByCountDeltaConflictV1 =
  | "replace-by-key"
  | "toggle-when-same";

export type LatestByCountDeltaDecisionV1 =
  | "insert"
  | "update"
  | "move"
  | "remove"
  | "unchanged"
  | "missing-remove";

export interface LatestByCountProjectionV1<Choice extends string> {
  group: string;
  choice: Choice;
}

export interface LatestByCountRowProjectionV1<
  Row,
  Choice extends string,
> extends LatestByCountProjectionV1<Choice> {
  row: Row;
}

export interface LatestByCountDeltaV1<Row, Choice extends string> {
  kind: LatestByCountDeltaV1Kind;
  latestKey: string;
  next?: LatestByCountRowProjectionV1<Row, Choice>;
  previous?: LatestByCountRowProjectionV1<Row, Choice>;
  choices: readonly Choice[];
  conflict: LatestByCountDeltaConflictV1;
}

export interface LatestByCountBucketDeltaV1<Choice extends string> {
  group: string;
  choice: Choice;
  delta: 1 | -1;
}

export interface LatestByCountDeltaEffectV1<Row, Choice extends string> {
  decision: LatestByCountDeltaDecisionV1;
  latestKey: string;
  nextRow?: Row;
  removeLatest: boolean;
  rowCountDelta: -1 | 0 | 1;
  bucketDeltas: readonly LatestByCountBucketDeltaV1<Choice>[];
}

export interface LatestByCountSnapshotV1<Row, Choice extends string> {
  latestByKey: KeyedRecord<Row>;
  countsByGroup: KeyedRecord<CountBucket<Choice>>;
  count: number;
}

export function latestByCountDeltaV1<Row, Choice extends string>(
  delta: Omit<LatestByCountDeltaV1<Row, Choice>, "kind">,
): LatestByCountDeltaV1<Row, Choice> {
  return { kind: LATEST_BY_COUNT_DELTA_V1_KIND, ...delta };
}

export function evaluateLatestByCountDeltaV1<Row, Choice extends string>(
  delta: LatestByCountDeltaV1<Row, Choice>,
): LatestByCountDeltaEffectV1<Row, Choice> {
  const previous = delta.previous;
  const next = delta.next;

  if (!next) {
    if (!previous) {
      return noChange(delta.latestKey, "missing-remove");
    }
    return {
      decision: "remove",
      latestKey: delta.latestKey,
      removeLatest: true,
      rowCountDelta: -1,
      bucketDeltas: [{
        group: previous.group,
        choice: previous.choice,
        delta: -1,
      }],
    };
  }

  if (
    previous &&
    previous.group === next.group &&
    previous.choice === next.choice
  ) {
    if (delta.conflict !== "toggle-when-same") {
      return {
        decision: "update",
        latestKey: delta.latestKey,
        nextRow: next.row,
        removeLatest: false,
        rowCountDelta: 0,
        bucketDeltas: [],
      };
    }
    return {
      decision: "remove",
      latestKey: delta.latestKey,
      removeLatest: true,
      rowCountDelta: -1,
      bucketDeltas: [{
        group: previous.group,
        choice: previous.choice,
        delta: -1,
      }],
    };
  }

  if (!previous) {
    return {
      decision: "insert",
      latestKey: delta.latestKey,
      nextRow: next.row,
      removeLatest: false,
      rowCountDelta: 1,
      bucketDeltas: [{ group: next.group, choice: next.choice, delta: 1 }],
    };
  }

  const decision = previous.group === next.group ? "update" : "move";
  return {
    decision,
    latestKey: delta.latestKey,
    nextRow: next.row,
    removeLatest: false,
    rowCountDelta: 0,
    bucketDeltas: [
      { group: previous.group, choice: previous.choice, delta: -1 },
      { group: next.group, choice: next.choice, delta: 1 },
    ],
  };
}

export function applyLatestByCountDeltaToSnapshotV1<
  Row,
  Choice extends string,
>(
  snapshot: LatestByCountSnapshotV1<Row, Choice>,
  delta: LatestByCountDeltaV1<Row, Choice>,
): LatestByCountSnapshotV1<Row, Choice> {
  const effect = evaluateLatestByCountDeltaV1(delta);
  const latestByKey: KeyedRecord<Row> = { ...snapshot.latestByKey };
  const countsByGroup: KeyedRecord<CountBucket<Choice>> = {
    ...snapshot.countsByGroup,
  };

  if (effect.removeLatest) delete latestByKey[effect.latestKey];
  if (hasNextRowEffect(effect)) {
    latestByKey[effect.latestKey] = effect.nextRow;
  }

  for (const bucketDelta of effect.bucketDeltas) {
    countsByGroup[bucketDelta.group] = applyBucketDelta(
      countsByGroup[bucketDelta.group],
      bucketDelta,
      delta.choices,
    );
  }

  return {
    latestByKey,
    countsByGroup,
    count: Math.max(0, snapshot.count + effect.rowCountDelta),
  };
}

function hasNextRowEffect<Row, Choice extends string>(
  effect: LatestByCountDeltaEffectV1<Row, Choice>,
): effect is LatestByCountDeltaEffectV1<Row, Choice> & { nextRow: Row } {
  return Object.hasOwn(effect, "nextRow");
}

function noChange<Row, Choice extends string>(
  latestKey: string,
  decision: "unchanged" | "missing-remove",
): LatestByCountDeltaEffectV1<Row, Choice> {
  return {
    decision,
    latestKey,
    removeLatest: false,
    rowCountDelta: 0,
    bucketDeltas: [],
  };
}

function applyBucketDelta<Choice extends string>(
  bucket: CountBucket<Choice> | undefined,
  delta: LatestByCountBucketDeltaV1<Choice>,
  choices: readonly Choice[],
): CountBucket<Choice> {
  const choicesRecord = {} as Record<Choice, number>;
  for (const choice of choices) {
    choicesRecord[choice] = bucket?.choices[choice] ?? 0;
  }
  choicesRecord[delta.choice] = Math.max(
    0,
    (choicesRecord[delta.choice] ?? 0) + delta.delta,
  );
  return {
    total: Math.max(0, (bucket?.total ?? 0) + delta.delta),
    choices: choicesRecord,
  };
}
