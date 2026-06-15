import {
  evaluateLatestByCountDeltaV1 as evaluateLatestByCountDeltaEffectV1,
  type LatestByCountDeltaEffectV1 as LatestByCountEffectV1,
  latestByCountDeltaV1 as makeLatestByCountDeltaV1,
} from "./latest-by-count-delta-v1.ts";

export {
  applyLatestByCountDeltaToSnapshotV1,
  evaluateLatestByCountDeltaV1,
  LATEST_BY_COUNT_DELTA_V1_KIND,
  latestByCountDeltaV1,
} from "./latest-by-count-delta-v1.ts";
export type {
  LatestByCountBucketDeltaV1,
  LatestByCountDeltaConflictV1,
  LatestByCountDeltaDecisionV1,
  LatestByCountDeltaEffectV1,
  LatestByCountDeltaV1,
  LatestByCountDeltaV1Kind,
  LatestByCountProjectionV1,
  LatestByCountRowProjectionV1,
  LatestByCountSnapshotV1,
} from "./latest-by-count-delta-v1.ts";

export { executeViewPlanV1 } from "./view-plan-executor-v1.ts";
export type {
  ViewPlanLatestRowsAndCountBucketsV1,
  ViewPlanOrderedValuesV1,
  ViewPlanReferenceExecutionV1,
  ViewPlanReferenceViewV1,
  ViewPlanRowV1,
} from "./view-plan-executor-v1.ts";

export {
  checkKeyedCollectionsViewPlanParityV1,
} from "./view-plan-parity-v1.ts";
export type {
  ViewPlanParityCheckV1,
  ViewPlanParityReportV1,
} from "./view-plan-parity-v1.ts";

export {
  explainViewPlanV1,
  latestByCountViewPlanV1,
  orderedCollectionViewPlanV1,
  validateViewPlanV1,
  VIEW_PLAN_V1_VERSION,
  viewPlanV1,
} from "./view-plan-v1.ts";
export type {
  LatestByCountViewPlanOptionsV1,
  OrderedCollectionViewPlanOptionsV1,
  ViewPlanConflictPolicy,
  ViewPlanExecutionTier,
  ViewPlanFallbackMode,
  ViewPlanFallbackV1,
  ViewPlanOptionsV1,
  ViewPlanOrderingV1,
  ViewPlanSourceShape,
  ViewPlanSourceV1,
  ViewPlanStepKind,
  ViewPlanStepV1,
  ViewPlanV1,
  ViewPlanV1Version,
  ViewPlanValidationV1,
} from "./view-plan-v1.ts";

export type KeyedRecord<T> = Record<string, T>;

export interface ValueCell<T> {
  get(): T;
  set(value: T): void;
}

export interface KeyedValueCell<T> extends ValueCell<T | undefined> {
  set(value: T): void;
}

export interface OrderedKeysCell<Empty extends string[] = string[]> {
  get(): readonly string[];
  set(value: string[]): void;
  push(value: string): void;
}

export interface KeyedRecordCell<
  Item,
  Empty extends KeyedRecord<Item> = KeyedRecord<Item>,
> extends ValueCell<KeyedRecord<Item>> {
  key(key: string): KeyedValueCell<Item>;
}

export interface CountBucketCell<
  Choice extends string,
  Empty extends KeyedRecord<CountBucket<Choice>> = KeyedRecord<
    CountBucket<Choice>
  >,
> extends ValueCell<KeyedRecord<CountBucket<Choice>>> {
  key(key: string): KeyedValueCell<CountBucket<Choice>>;
}

export type CountCell = ValueCell<number>;

export interface CountBucket<Choice extends string> {
  total: number;
  choices: Record<Choice, number>;
}

export interface OrderedCollectionCells<
  Item,
  EmptyOrder extends string[],
  EmptyItems extends KeyedRecord<Item>,
> {
  order: OrderedKeysCell<EmptyOrder>;
  byId: KeyedRecordCell<Item, EmptyItems>;
  count: CountCell;
}

export interface LatestByCountCells<
  Item,
  Choice extends string,
  EmptyLatest extends KeyedRecord<Item>,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
> {
  latestByKey: KeyedRecordCell<Item, EmptyLatest>;
  countsByGroup: CountBucketCell<Choice, EmptyCounts>;
  count: CountCell;
}

export interface LatestByCountConfig<Item, Choice extends string> {
  latestKey: string;
  item: Item;
  group: string;
  choice: Choice;
  previousGroup?: string;
  previousChoice?: Choice;
  choices: readonly Choice[];
  removeWhenSame?: boolean;
}

export type LatestByCountResult =
  | "added"
  | "updated"
  | "removed"
  | "unchanged";

export function encodeKey(...parts: readonly string[]): string {
  return parts.map((part) => `k:${encodeURIComponent(part)}`).join("::");
}

export function readKey<Item, Empty extends KeyedRecord<Item>>(
  byId: KeyedRecordCell<Item, Empty>,
  key: string,
): Item | undefined {
  return byId.key(key).get() as Item | undefined;
}

export function hasKey<Item, Empty extends KeyedRecord<Item>>(
  byId: KeyedRecordCell<Item, Empty>,
  key: string,
): boolean {
  return Object.hasOwn(byId.get(), key);
}

export function orderedValues<Item>(
  order: readonly string[],
  byId: KeyedRecord<Item>,
): Item[] {
  const values: Item[] = [];
  for (const id of order) {
    const value = byId[id];
    if (value !== undefined) values.push(value);
  }
  return values;
}

export function filteredOrderedValues<Item>(
  order: readonly string[],
  byId: KeyedRecord<Item>,
  predicate: (item: Item, key: string) => boolean,
): Item[] {
  const values: Item[] = [];
  for (const key of order) {
    const value = byId[key];
    if (value !== undefined && predicate(value, key)) values.push(value);
  }
  return values;
}

export function countOrderedWhere<Item>(
  order: readonly string[],
  byId: KeyedRecord<Item>,
  predicate: (item: Item, key: string) => boolean,
): number {
  let total = 0;
  for (const key of order) {
    const value = byId[key];
    if (value !== undefined && predicate(value, key)) total += 1;
  }
  return total;
}

export function replaceOrderedFromArray<
  Item,
  EmptyOrder extends string[],
  EmptyItems extends KeyedRecord<Item>,
>(
  cells: OrderedCollectionCells<Item, EmptyOrder, EmptyItems>,
  items: readonly Item[],
  keyOf: (item: Item) => string,
): void {
  const nextOrder: string[] = [];
  const nextById: KeyedRecord<Item> = {};
  for (const item of items) {
    const rawKey = keyOf(item).trim();
    if (!rawKey) continue;
    const key = encodeKey(rawKey);
    if (!Object.hasOwn(nextById, key)) nextOrder.push(key);
    nextById[key] = item;
  }
  cells.order.set(nextOrder as EmptyOrder);
  cells.byId.set(nextById as EmptyItems);
  cells.count.set(nextOrder.length);
}

export function upsertOrdered<
  Item,
  EmptyOrder extends string[],
  EmptyItems extends KeyedRecord<Item>,
>(
  cells: OrderedCollectionCells<Item, EmptyOrder, EmptyItems>,
  id: string,
  item: Item,
): "added" | "updated" | "ignored" {
  const trimmed = id.trim();
  if (!trimmed) return "ignored";
  if (!hasKey(cells.byId, trimmed)) {
    cells.order.push(trimmed);
    cells.count.set(cells.count.get() + 1);
    cells.byId.key(trimmed).set(item);
    return "added";
  }
  cells.byId.key(trimmed).set(item);
  return "updated";
}

export function removeOrdered<
  Item,
  EmptyOrder extends string[],
  EmptyItems extends KeyedRecord<Item>,
>(
  cells: OrderedCollectionCells<Item, EmptyOrder, EmptyItems>,
  id: string,
): Item | undefined {
  if (!hasKey(cells.byId, id)) return undefined;
  const existing = readKey(cells.byId, id);
  const next: KeyedRecord<Item> = {};
  for (const [key, value] of Object.entries(cells.byId.get())) {
    if (key !== id) next[key] = value;
  }
  cells.byId.set(next as EmptyItems);
  cells.order.set(cells.order.get().filter((key) => key !== id));
  cells.count.set(Math.max(0, cells.count.get() - 1));
  return existing;
}

export function zeroBucket<Choice extends string>(
  choices: readonly Choice[],
): CountBucket<Choice> {
  const counts = {} as Record<Choice, number>;
  for (const choice of choices) counts[choice] = 0;
  return { total: 0, choices: counts };
}

export function countSnapshot<
  Choice extends string,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
>(
  countsByGroup: CountBucketCell<Choice, EmptyCounts>,
  group: string,
  choices: readonly Choice[],
): CountBucket<Choice> {
  return hasKey(countsByGroup, group)
    ? readKey(countsByGroup, group) ?? zeroBucket(choices)
    : zeroBucket(choices);
}

function adjustBucket<
  Choice extends string,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
>(
  countsByGroup: CountBucketCell<Choice, EmptyCounts>,
  group: string,
  choice: Choice,
  delta: 1 | -1,
  choices: readonly Choice[],
): void {
  const current = countSnapshot(countsByGroup, group, choices);
  const next: CountBucket<Choice> = {
    total: Math.max(0, current.total + delta),
    choices: { ...current.choices },
  };
  next.choices[choice] = Math.max(0, (next.choices[choice] ?? 0) + delta);
  countsByGroup.key(group).set(next);
}

function removeLatestKey<
  Item,
  EmptyLatest extends KeyedRecord<Item>,
>(
  latestByKey: KeyedRecordCell<Item, EmptyLatest>,
  latestKey: string,
): void {
  const next: KeyedRecord<Item> = {};
  for (const [key, value] of Object.entries(latestByKey.get())) {
    if (key !== latestKey) next[key] = value;
  }
  latestByKey.set(next as EmptyLatest);
}

function applyLatestByCountEffect<
  Item,
  Choice extends string,
  EmptyLatest extends KeyedRecord<Item>,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
>(
  cells: LatestByCountCells<Item, Choice, EmptyLatest, EmptyCounts>,
  effect: LatestByCountEffectV1<Item, Choice>,
  choices: readonly Choice[],
): void {
  if (effect.removeLatest) removeLatestKey(cells.latestByKey, effect.latestKey);
  if (hasNextRowEffect(effect)) {
    cells.latestByKey.key(effect.latestKey).set(effect.nextRow);
  }
  if (effect.rowCountDelta !== 0) {
    cells.count.set(Math.max(0, cells.count.get() + effect.rowCountDelta));
  }
  for (const bucketDelta of effect.bucketDeltas) {
    adjustBucket(
      cells.countsByGroup,
      bucketDelta.group,
      bucketDelta.choice,
      bucketDelta.delta,
      choices,
    );
  }
}

function hasNextRowEffect<Item, Choice extends string>(
  effect: LatestByCountEffectV1<Item, Choice>,
): effect is LatestByCountEffectV1<Item, Choice> & { nextRow: Item } {
  return Object.hasOwn(effect, "nextRow");
}

function resultFromDeltaDecision(
  decision: LatestByCountEffectV1<unknown, string>["decision"],
): LatestByCountResult {
  if (decision === "insert") return "added";
  if (decision === "remove") return "removed";
  if (decision === "update" || decision === "move") return "updated";
  return "unchanged";
}

export function applyLatestByCount<
  Item,
  Choice extends string,
  EmptyLatest extends KeyedRecord<Item>,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
>(
  cells: LatestByCountCells<Item, Choice, EmptyLatest, EmptyCounts>,
  config: LatestByCountConfig<Item, Choice>,
): LatestByCountResult {
  const hasPrevious = hasKey(cells.latestByKey, config.latestKey);
  const previousItem = hasPrevious
    ? readKey(cells.latestByKey, config.latestKey)
    : undefined;
  if (
    hasPrevious &&
    (previousItem === undefined || config.previousGroup === undefined ||
      config.previousChoice === undefined)
  ) {
    return "unchanged";
  }

  const effect = evaluateLatestByCountDeltaEffectV1(
    makeLatestByCountDeltaV1({
      latestKey: config.latestKey,
      previous: hasPrevious
        ? {
          row: previousItem as Item,
          group: config.previousGroup as string,
          choice: config.previousChoice as Choice,
        }
        : undefined,
      next: { row: config.item, group: config.group, choice: config.choice },
      choices: config.choices,
      conflict: config.removeWhenSame === true
        ? "toggle-when-same"
        : "replace-by-key",
    }),
  );
  applyLatestByCountEffect(cells, effect, config.choices);
  return resultFromDeltaDecision(effect.decision);
}

export function removeLatestByCount<
  Item,
  Choice extends string,
  EmptyLatest extends KeyedRecord<Item>,
  EmptyCounts extends KeyedRecord<CountBucket<Choice>>,
>(
  cells: LatestByCountCells<Item, Choice, EmptyLatest, EmptyCounts>,
  config: {
    latestKey: string;
    group: string;
    choice: Choice;
    choices: readonly Choice[];
  },
): Item | undefined {
  if (!hasKey(cells.latestByKey, config.latestKey)) return undefined;
  const existing = readKey(cells.latestByKey, config.latestKey);
  if (existing === undefined) return undefined;
  const effect = evaluateLatestByCountDeltaEffectV1(
    makeLatestByCountDeltaV1({
      latestKey: config.latestKey,
      previous: { row: existing, group: config.group, choice: config.choice },
      choices: config.choices,
      conflict: "replace-by-key",
    }),
  );
  applyLatestByCountEffect(cells, effect, config.choices);
  return existing;
}
