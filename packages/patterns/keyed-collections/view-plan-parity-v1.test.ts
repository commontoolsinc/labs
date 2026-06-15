import { assertEquals } from "@std/assert";
import {
  checkKeyedCollectionsViewPlanParityV1,
  latestByCountViewPlanV1,
  orderedCollectionViewPlanV1,
} from "./keyed-collection-v1.ts";

const CHOICES = ["red", "yellow", "green"] as const;

const viewPlans = [
  orderedCollectionViewPlanV1({
    name: "coffee-origin-options@1",
    source: "options",
    item: "PocOption",
    key: "id",
    cells: ["optionOrder", "optionsById", "optionCount"],
    outputs: ["options", "optionCount"],
    conflict: "reject",
  }),
  latestByCountViewPlanV1({
    name: "coffee-origin-vote-tallies@1",
    source: "votes",
    item: "PocVote",
    latestKey: "voter",
    groupBy: "optionId",
    choice: "choice",
    choices: CHOICES,
    cells: ["votesByVoter", "tallyBucketsByOption", "voteCount"],
    outputs: [
      "votes",
      "tallies",
      "votedOptions",
      "votedOptionCount",
      "voteCount",
    ],
    removeWhenSame: true,
  }),
];

Deno.test("checkKeyedCollectionsViewPlanParityV1 passes matching sanitized output", () => {
  const report = checkKeyedCollectionsViewPlanParityV1({
    viewPlans,
    options: [
      { id: "ethiopia", title: "Ethiopia" },
      { id: "colombia", title: "Colombia" },
    ],
    votedOptions: [{ id: "colombia", title: "Colombia" }],
    votes: [{ voter: "alice", optionId: "colombia", choice: "green" }],
    tallies: [
      {
        optionId: "ethiopia",
        title: "Ethiopia",
        red: 0,
        yellow: 0,
        green: 0,
        total: 0,
      },
      {
        optionId: "colombia",
        title: "Colombia",
        red: 0,
        yellow: 0,
        green: 1,
        total: 1,
      },
    ],
    optionCount: 2,
    voteCount: 1,
    votedOptionCount: 1,
  });

  assertEquals(report.status, "passed");
  assertEquals(report.ok, true);
  assertEquals(report.errors, []);
  assertEquals(report.checks.length, 6);
});

Deno.test("checkKeyedCollectionsViewPlanParityV1 fails on output mismatch", () => {
  const report = checkKeyedCollectionsViewPlanParityV1({
    viewPlans,
    options: [{ id: "ethiopia", title: "Ethiopia" }],
    votedOptions: [],
    votes: [{ voter: "alice", optionId: "ethiopia", choice: "green" }],
    tallies: [
      {
        optionId: "ethiopia",
        title: "Ethiopia",
        red: 0,
        yellow: 0,
        green: 0,
        total: 0,
      },
    ],
    optionCount: 1,
    voteCount: 1,
    votedOptionCount: 0,
  });

  assertEquals(report.status, "failed");
  assertEquals(report.ok, false);
  assertEquals(report.errors, [
    "count buckets match tallies: executor count buckets differ from published tallies",
    "voted options match nonzero buckets: published votedOptions differ from nonzero executor buckets",
  ]);
});

Deno.test("checkKeyedCollectionsViewPlanParityV1 fails on extra tally rows", () => {
  const report = checkKeyedCollectionsViewPlanParityV1({
    viewPlans,
    options: [{ id: "ethiopia", title: "Ethiopia" }],
    votedOptions: [],
    votes: [],
    tallies: [
      {
        optionId: "ethiopia",
        title: "Ethiopia",
        red: 0,
        yellow: 0,
        green: 0,
        total: 0,
      },
      {
        optionId: "colombia",
        title: "Colombia",
        red: 0,
        yellow: 0,
        green: 0,
        total: 0,
      },
    ],
    optionCount: 1,
    voteCount: 0,
    votedOptionCount: 0,
  });

  assertEquals(report.errors, [
    "count buckets match tallies: executor count buckets differ from published tallies",
  ]);
});

Deno.test("checkKeyedCollectionsViewPlanParityV1 fails on orphan nonzero vote buckets", () => {
  const report = checkKeyedCollectionsViewPlanParityV1({
    viewPlans,
    options: [{ id: "ethiopia", title: "Ethiopia" }],
    votedOptions: [],
    votes: [{ voter: "alice", optionId: "missing", choice: "green" }],
    tallies: [
      {
        optionId: "ethiopia",
        title: "Ethiopia",
        red: 0,
        yellow: 0,
        green: 0,
        total: 0,
      },
    ],
    optionCount: 1,
    voteCount: 1,
    votedOptionCount: 0,
  });

  assertEquals(report.errors, [
    "count buckets match tallies: executor count buckets differ from published tallies",
    "voted options match nonzero buckets: published votedOptions differ from nonzero executor buckets",
  ]);
});

Deno.test("checkKeyedCollectionsViewPlanParityV1 skips outputs without viewPlans", () => {
  assertEquals(checkKeyedCollectionsViewPlanParityV1({ optionCount: 1 }), {
    status: "skipped",
    ok: true,
    checks: [],
    errors: ["output has no viewPlans"],
  });
});

Deno.test("checkKeyedCollectionsViewPlanParityV1 fails closed on malformed rows", () => {
  assertEquals(
    checkKeyedCollectionsViewPlanParityV1({
      viewPlans,
      options: [{ id: "ethiopia", title: "" }],
      votedOptions: [],
      votes: [],
      tallies: [],
      optionCount: 1,
      voteCount: 0,
      votedOptionCount: 0,
    }),
    {
      status: "failed",
      ok: false,
      checks: [],
      errors: ["option.title must be a nonblank string"],
    },
  );
});
