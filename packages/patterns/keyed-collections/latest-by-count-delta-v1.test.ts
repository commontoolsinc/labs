import { assertEquals } from "@std/assert";
import {
  applyLatestByCountDeltaToSnapshotV1,
  evaluateLatestByCountDeltaV1,
  latestByCountDeltaV1,
  type LatestByCountSnapshotV1,
} from "./keyed-collection-v1.ts";

type Choice = "green" | "yellow" | "red";

interface VoteRow {
  voter: string;
  optionId: string;
  choice: Choice;
}

const CHOICES: readonly Choice[] = ["green", "yellow", "red"];

const emptySnapshot = (): LatestByCountSnapshotV1<VoteRow, Choice> => ({
  latestByKey: {},
  countsByGroup: {},
  count: 0,
});

const row = (
  voter: string,
  optionId: string,
  choice: Choice,
): VoteRow => ({ voter, optionId, choice });

Deno.test("latestByCountDelta inserts first latest row and increments bucket", () => {
  const alice = row("alice", "ethiopia", "green");
  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    next: { row: alice, group: "ethiopia", choice: "green" },
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta), {
    decision: "insert",
    latestKey: "alice",
    nextRow: alice,
    removeLatest: false,
    rowCountDelta: 1,
    bucketDeltas: [{ group: "ethiopia", choice: "green", delta: 1 }],
  });
  assertEquals(applyLatestByCountDeltaToSnapshotV1(emptySnapshot(), delta), {
    latestByKey: { alice },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  });
});

Deno.test("latestByCountDelta updates choice without changing row count", () => {
  const previous = row("alice", "ethiopia", "green");
  const next = row("alice", "ethiopia", "red");
  const snapshot: LatestByCountSnapshotV1<VoteRow, Choice> = {
    latestByKey: { alice: previous },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  };

  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    previous: { row: previous, group: "ethiopia", choice: "green" },
    next: { row: next, group: "ethiopia", choice: "red" },
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta).decision, "update");
  assertEquals(applyLatestByCountDeltaToSnapshotV1(snapshot, delta), {
    latestByKey: { alice: next },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 0, yellow: 0, red: 1 } },
    },
    count: 1,
  });
});

Deno.test("latestByCountDelta replaces same projection row without count changes", () => {
  const previous = row("alice", "ethiopia", "green");
  const next = { ...previous, note: "fresh payload" } as VoteRow & {
    note: string;
  };
  const snapshot: LatestByCountSnapshotV1<typeof next, Choice> = {
    latestByKey: { alice: previous as typeof next },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  };

  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    previous: {
      row: previous as typeof next,
      group: "ethiopia",
      choice: "green",
    },
    next: { row: next, group: "ethiopia", choice: "green" },
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta), {
    decision: "update",
    latestKey: "alice",
    nextRow: next,
    removeLatest: false,
    rowCountDelta: 0,
    bucketDeltas: [],
  });
  assertEquals(applyLatestByCountDeltaToSnapshotV1(snapshot, delta), {
    latestByKey: { alice: next },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  });
});

Deno.test("latestByCountDelta moves a latest row between groups", () => {
  const previous = row("alice", "ethiopia", "green");
  const next = row("alice", "colombia", "green");
  const snapshot: LatestByCountSnapshotV1<VoteRow, Choice> = {
    latestByKey: { alice: previous },
    countsByGroup: {
      ethiopia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
      colombia: { total: 0, choices: { green: 0, yellow: 0, red: 0 } },
    },
    count: 1,
  };

  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    previous: { row: previous, group: "ethiopia", choice: "green" },
    next: { row: next, group: "colombia", choice: "green" },
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta).decision, "move");
  assertEquals(applyLatestByCountDeltaToSnapshotV1(snapshot, delta), {
    latestByKey: { alice: next },
    countsByGroup: {
      ethiopia: { total: 0, choices: { green: 0, yellow: 0, red: 0 } },
      colombia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  });
});

Deno.test("latestByCountDelta toggles same latest row off", () => {
  const alice = row("alice", "colombia", "green");
  const snapshot: LatestByCountSnapshotV1<VoteRow, Choice> = {
    latestByKey: { alice },
    countsByGroup: {
      colombia: { total: 1, choices: { green: 1, yellow: 0, red: 0 } },
    },
    count: 1,
  };

  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    previous: { row: alice, group: "colombia", choice: "green" },
    next: { row: alice, group: "colombia", choice: "green" },
    choices: CHOICES,
    conflict: "toggle-when-same",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta).decision, "remove");
  assertEquals(applyLatestByCountDeltaToSnapshotV1(snapshot, delta), {
    latestByKey: {},
    countsByGroup: {
      colombia: { total: 0, choices: { green: 0, yellow: 0, red: 0 } },
    },
    count: 0,
  });
});

Deno.test("latestByCountDelta removes an existing latest row explicitly", () => {
  const alice = row("alice", "colombia", "yellow");
  const snapshot: LatestByCountSnapshotV1<VoteRow, Choice> = {
    latestByKey: { alice },
    countsByGroup: {
      colombia: { total: 1, choices: { green: 0, yellow: 1, red: 0 } },
    },
    count: 1,
  };

  const delta = latestByCountDeltaV1({
    latestKey: "alice",
    previous: { row: alice, group: "colombia", choice: "yellow" },
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta), {
    decision: "remove",
    latestKey: "alice",
    removeLatest: true,
    rowCountDelta: -1,
    bucketDeltas: [{ group: "colombia", choice: "yellow", delta: -1 }],
  });
  assertEquals(applyLatestByCountDeltaToSnapshotV1(snapshot, delta), {
    latestByKey: {},
    countsByGroup: {
      colombia: { total: 0, choices: { green: 0, yellow: 0, red: 0 } },
    },
    count: 0,
  });
});

Deno.test("latestByCountDelta treats missing remove as no-op", () => {
  const delta = latestByCountDeltaV1<VoteRow, Choice>({
    latestKey: "missing",
    choices: CHOICES,
    conflict: "replace-by-key",
  });

  assertEquals(evaluateLatestByCountDeltaV1(delta), {
    decision: "missing-remove",
    latestKey: "missing",
    removeLatest: false,
    rowCountDelta: 0,
    bucketDeltas: [],
  });
  assertEquals(applyLatestByCountDeltaToSnapshotV1(emptySnapshot(), delta), {
    latestByKey: {},
    countsByGroup: {},
    count: 0,
  });
});
