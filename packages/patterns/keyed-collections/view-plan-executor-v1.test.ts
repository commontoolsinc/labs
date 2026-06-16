import { assertEquals } from "@std/assert";
import {
  executeViewPlanV1,
  latestByCountViewPlanV1,
  orderedCollectionViewPlanV1,
  type ViewPlanV1,
  viewPlanV1,
} from "./keyed-collection-v1.ts";

type Choice = "green" | "yellow" | "red";

interface OptionRow extends Record<string, unknown> {
  id: string;
  title: string;
}

interface VoteRow extends Record<string, unknown> {
  voter: string;
  optionId: string;
  choice: Choice;
  note?: string;
}

const CHOICES: readonly Choice[] = ["green", "yellow", "red"];

const optionsPlan = (): ViewPlanV1 =>
  orderedCollectionViewPlanV1({
    name: "coffee-origin-options@1",
    source: "options",
    item: "OptionRow",
    key: "id",
    cells: ["optionOrder", "optionsById", "optionCount"],
    outputs: ["options", "optionCount"],
    conflict: "replace-by-key",
  });

const votesPlan = (removeWhenSame = true): ViewPlanV1 =>
  latestByCountViewPlanV1({
    name: "coffee-origin-vote-tallies@1",
    source: "votes",
    item: "VoteRow",
    latestKey: "voter",
    groupBy: "optionId",
    choice: "choice",
    choices: CHOICES,
    cells: ["votesByVoter", "tallyBucketsByOption", "voteCount"],
    outputs: ["votes", "tallies", "voteCount"],
    removeWhenSame,
  });

Deno.test("executeViewPlanV1 materializes ordered keyed rows", () => {
  const ethiopia = { id: "ethiopia", title: "Ethiopia" };
  const colombia = { id: "colombia", title: "Colombia" };
  const ethiopiaUpdated = { id: "ethiopia", title: "Ethiopia AA" };

  assertEquals(
    executeViewPlanV1<OptionRow>(optionsPlan(), [
      ethiopia,
      colombia,
      ethiopiaUpdated,
    ]),
    {
      ok: true,
      result: {
        view: "orderedValues",
        rows: [ethiopiaUpdated, colombia],
        byKey: {
          "k:ethiopia": ethiopiaUpdated,
          "k:colombia": colombia,
        },
        order: ["k:ethiopia", "k:colombia"],
        count: 2,
      },
    },
  );
});

Deno.test("executeViewPlanV1 applies latestByCountDelta lowering", () => {
  const aliceGreen = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green" as const,
  };
  const aliceRed = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "red" as const,
    note: "changed mind",
  };
  const aliceColombia = {
    voter: "alice",
    optionId: "colombia",
    choice: "green" as const,
  };
  const bobYellow = {
    voter: "bob",
    optionId: "colombia",
    choice: "yellow" as const,
  };

  assertEquals(
    executeViewPlanV1<VoteRow>(votesPlan(), [
      aliceGreen,
      aliceRed,
      aliceColombia,
      bobYellow,
      aliceColombia,
    ]),
    {
      ok: true,
      result: {
        view: "latestRowsAndCountBuckets",
        latestRows: [bobYellow],
        latestByKey: { "k:bob": bobYellow },
        countsByGroup: {
          "k:ethiopia": {
            total: 0,
            choices: { green: 0, yellow: 0, red: 0 },
          },
          "k:colombia": {
            total: 1,
            choices: { green: 0, yellow: 1, red: 0 },
          },
        },
        count: 1,
      },
    },
  );
});

Deno.test("executeViewPlanV1 replaces same projection payload without count churn", () => {
  const first = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green" as const,
  };
  const second = {
    voter: "alice",
    optionId: "ethiopia",
    choice: "green" as const,
    note: "fresh payload",
  };

  assertEquals(executeViewPlanV1<VoteRow>(votesPlan(false), [first, second]), {
    ok: true,
    result: {
      view: "latestRowsAndCountBuckets",
      latestRows: [second],
      latestByKey: { "k:alice": second },
      countsByGroup: {
        "k:ethiopia": {
          total: 1,
          choices: { green: 1, yellow: 0, red: 0 },
        },
      },
      count: 1,
    },
  });
});

Deno.test("executeViewPlanV1 fails closed for malformed rows and plans", () => {
  const badRows = executeViewPlanV1<VoteRow>(votesPlan(), [{
    voter: "alice",
    optionId: "ethiopia",
    choice: "purple" as Choice,
  }]);
  assertEquals(badRows, {
    ok: false,
    error: 'unsupported choice "purple"',
  });

  const badPlan = viewPlanV1({
    name: "bad-materialize",
    source: { name: "votes", shape: "latest-record", item: "VoteRow" },
    steps: [{ kind: "materialize", view: "everything", outputs: ["all"] }],
    fallback: { mode: "cell-helper", helper: "none" },
  });
  assertEquals(executeViewPlanV1<VoteRow>(badPlan, []), {
    ok: false,
    error: "unsupported materialized view: everything",
  });
});

Deno.test("executeViewPlanV1 rejects unsupported orderedValues orderings", () => {
  const plan = viewPlanV1({
    name: "unsupported-order",
    source: {
      name: "options",
      shape: "ordered-keyed-record",
      item: "OptionRow",
    },
    steps: [
      { kind: "keyBy", fields: ["id"], conflict: "replace-by-key" },
      { kind: "orderBy", order: [{ field: "title", direction: "desc" }] },
      { kind: "materialize", view: "orderedValues", outputs: ["options"] },
    ],
    fallback: { mode: "cell-helper", helper: "test" },
  });

  assertEquals(executeViewPlanV1<OptionRow>(plan, []), {
    ok: false,
    error: "orderedValues supports only $insertion asc, $key asc ordering",
  });
});

Deno.test("executeViewPlanV1 rejects duplicate or out-of-order steps", () => {
  const duplicate = viewPlanV1({
    name: "duplicate-keyBy",
    source: {
      name: "options",
      shape: "ordered-keyed-record",
      item: "OptionRow",
    },
    steps: [
      { kind: "keyBy", fields: ["id"] },
      { kind: "keyBy", fields: ["title"] },
      {
        kind: "orderBy",
        order: [
          { field: "$insertion", direction: "asc" },
          { field: "$key", direction: "asc" },
        ],
      },
      { kind: "materialize", view: "orderedValues", outputs: ["options"] },
    ],
    fallback: { mode: "cell-helper", helper: "test" },
  });
  assertEquals(executeViewPlanV1<OptionRow>(duplicate, []), {
    ok: false,
    error:
      "orderedValues requires step pipeline keyBy -> orderBy -> materialize",
  });

  const outOfOrder = viewPlanV1({
    name: "out-of-order-latest",
    source: { name: "votes", shape: "latest-record", item: "VoteRow" },
    steps: [
      { kind: "latestBy", fields: ["voter"], conflict: "toggle-when-same" },
      {
        kind: "countBy",
        groupFields: ["optionId"],
        choiceField: "choice",
        choices: [...CHOICES],
      },
      { kind: "groupBy", fields: ["optionId"] },
      {
        kind: "materialize",
        view: "latestRowsAndCountBuckets",
        outputs: ["votes"],
        lowering: "latestByCountDelta@1",
      },
    ],
    fallback: { mode: "cell-helper", helper: "test" },
  });
  assertEquals(executeViewPlanV1<VoteRow>(outOfOrder, []), {
    ok: false,
    error:
      "latestRowsAndCountBuckets requires step pipeline latestBy -> groupBy -> countBy -> materialize",
  });
});

Deno.test("executeViewPlanV1 rejects mismatched groupBy and countBy fields", () => {
  const plan = viewPlanV1({
    name: "mismatched-groups",
    source: { name: "votes", shape: "latest-record", item: "VoteRow" },
    steps: [
      { kind: "latestBy", fields: ["voter"], conflict: "toggle-when-same" },
      { kind: "groupBy", fields: ["optionId"] },
      {
        kind: "countBy",
        groupFields: ["country"],
        choiceField: "choice",
        choices: [...CHOICES],
      },
      {
        kind: "materialize",
        view: "latestRowsAndCountBuckets",
        outputs: ["votes"],
        lowering: "latestByCountDelta@1",
      },
    ],
    fallback: { mode: "cell-helper", helper: "test" },
  });

  assertEquals(executeViewPlanV1<VoteRow>(plan, []), {
    ok: false,
    error: "countBy.groupFields must match groupBy.fields",
  });
});
