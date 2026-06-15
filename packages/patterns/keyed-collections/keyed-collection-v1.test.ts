import { assertEquals } from "@std/assert";
import {
  applyLatestByCount,
  type CountBucket,
  type CountCell,
  type KeyedRecord,
  type KeyedRecordCell,
  type LatestByCountCells,
  removeLatestByCount,
} from "./keyed-collection-v1.ts";

type Choice = "green" | "yellow" | "red";

interface VoteRow {
  voter: string;
  optionId: string;
  choice: Choice;
  note?: string;
}

const CHOICES: readonly Choice[] = ["green", "yellow", "red"];

function keyedRecordCell<T>(
  initial: KeyedRecord<T>,
): KeyedRecordCell<T, KeyedRecord<T>> {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
    key: (key) => ({
      get: () => current[key],
      set: (value) => {
        current = { ...current, [key]: value };
      },
    }),
  };
}

function countCell(initial: number): CountCell {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

Deno.test("applyLatestByCount replaces same projection latest row without count deltas", () => {
  const previous: VoteRow = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green",
  };
  const next: VoteRow = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green",
    note: "fresh payload",
  };
  const latestByKey = keyedRecordCell<VoteRow>({ alice: previous });
  const countsByGroup = keyedRecordCell<CountBucket<Choice>>({
    ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
  });
  const count = countCell(1);
  const cells: LatestByCountCells<
    VoteRow,
    Choice,
    KeyedRecord<VoteRow>,
    KeyedRecord<CountBucket<Choice>>
  > = { latestByKey, countsByGroup, count };

  const result = applyLatestByCount(cells, {
    latestKey: "alice",
    item: next,
    group: "ethiopia",
    choice: "green",
    previousGroup: "ethiopia",
    previousChoice: "green",
    choices: CHOICES,
  });

  assertEquals(result, "updated");
  assertEquals(latestByKey.get(), { alice: next });
  assertEquals(countsByGroup.get(), {
    ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
  });
  assertEquals(count.get(), 1);
});

Deno.test("applyLatestByCount leaves aggregates unchanged when previous projection is missing", () => {
  const previous: VoteRow = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green",
  };
  const next: VoteRow = {
    voter: "alice",
    optionId: "colombia",
    choice: "red",
    note: "ambiguous without previous projection",
  };
  const latestByKey = keyedRecordCell<VoteRow>({ alice: previous });
  const countsByGroup = keyedRecordCell<CountBucket<Choice>>({
    ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
  });
  const count = countCell(1);
  const cells: LatestByCountCells<
    VoteRow,
    Choice,
    KeyedRecord<VoteRow>,
    KeyedRecord<CountBucket<Choice>>
  > = { latestByKey, countsByGroup, count };

  const result = applyLatestByCount(cells, {
    latestKey: "alice",
    item: next,
    group: "colombia",
    choice: "red",
    choices: CHOICES,
  });

  assertEquals(result, "unchanged");
  assertEquals(latestByKey.get(), { alice: previous });
  assertEquals(countsByGroup.get(), {
    ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
  });
  assertEquals(count.get(), 1);
});

Deno.test("removeLatestByCount removes row and decrements count and bucket", () => {
  const previous: VoteRow = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green",
  };
  const latestByKey = keyedRecordCell<VoteRow>({ alice: previous });
  const countsByGroup = keyedRecordCell<CountBucket<Choice>>({
    ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
  });
  const count = countCell(1);
  const cells: LatestByCountCells<
    VoteRow,
    Choice,
    KeyedRecord<VoteRow>,
    KeyedRecord<CountBucket<Choice>>
  > = { latestByKey, countsByGroup, count };

  const removed = removeLatestByCount(cells, {
    latestKey: "alice",
    group: "ethiopia",
    choice: "green",
    choices: CHOICES,
  });

  assertEquals(removed, previous);
  assertEquals(latestByKey.get(), {});
  assertEquals(countsByGroup.get(), {
    ethiopia: { total: 0, choices: { green: 0, yellow: 0, red: 0 } },
  });
  assertEquals(count.get(), 0);
});
