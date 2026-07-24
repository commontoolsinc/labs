import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { isSigilLink } from "@commonfabric/runner/shared";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(import.meta.dirname!, "..", "topics", "main.tsx");
const ROOT_PATH = join(import.meta.dirname!, "..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function firstTopic(session: MultiRuntimeSession): Promise<
  Record<string, unknown>
> {
  const topics = await session.read(["topics"]);
  assert(Array.isArray(topics), "Topics result must expose an array");
  const topic = topics[0];
  assert(isRecord(topic), "Topics result must expose the first topic");
  return topic;
}

describe("Topics nested stream dispatch across isolated runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      diagnostics: true,
      bootstrapProfile: true,
      sessions: ["alice", "bob"],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("dispatches nested handlers, drains queued commits, and preserves links through a root conflict", async () => {
    await Promise.all([
      alice.send(
        "addTopic",
        {
          title: "Nested handler topic",
          agentName: "Alice",
        },
        undefined,
        { idle: false },
      ),
      bob.send(
        "addTopic",
        {
          title: "Linked topic",
          agentName: "Bob",
        },
        undefined,
        { idle: false },
      ),
    ]);
    await harness.diagnosticsBarrier();
    await bob.telemetry();

    await bob.send(["topics", 0, "addComment"], {
      body: "A nested stream invocation",
      agentName: "Bob",
    });

    const handlerTelemetry = await bob.telemetry();
    assert(handlerTelemetry.invocationCount >= 1);
    assert(handlerTelemetry.distinctInvokedEventCount >= 1);
    assert(handlerTelemetry.distinctSuccessfulEventCount >= 1);
    assertEquals(handlerTelemetry.distinctDroppedEventCount, 0);
    assert(handlerTelemetry.commitMarkerCount >= 1);
    assert(handlerTelemetry.writeCount >= handlerTelemetry.changedWriteCount);
    assertEquals(JSON.stringify(handlerTelemetry).includes("eventId"), false);
    assertEquals(JSON.stringify(handlerTelemetry).includes("evt:"), false);

    await Promise.all([alice.telemetry(), bob.telemetry()]);
    harness.memoryTelemetry();
    await Promise.all([
      alice.send(
        ["topics", 0, "addLink"],
        {
          kind: "web",
          url: "https://example.invalid/diagnostic/alice",
          label: "Alice diagnostic link",
          agentName: "Alice",
        },
        undefined,
        { idle: false },
      ),
      bob.send(
        ["topics", 1, "addLink"],
        {
          kind: "web",
          url: "https://example.invalid/diagnostic/bob",
          label: "Bob diagnostic link",
          agentName: "Bob",
        },
        undefined,
        { idle: false },
      ),
    ]);
    await harness.diagnosticsBarrier();

    const propagatedComments = (await firstTopic(alice)).comments;
    assert(Array.isArray(propagatedComments));
    assert(isRecord(propagatedComments[0]));
    assertEquals(
      propagatedComments[0].body,
      "A nested stream invocation",
    );

    const eventTelemetry = await Promise.all([
      alice.telemetry(),
      bob.telemetry(),
    ]);
    const memoryTelemetry = harness.memoryTelemetry();
    const total = (key: keyof typeof eventTelemetry[number]): number =>
      eventTelemetry.reduce((sum, entry) => {
        const value = entry[key];
        return sum + (typeof value === "number" ? value : 0);
      }, 0);
    assertEquals({
      invoked: total("distinctInvokedEventCount"),
      successful: total("distinctSuccessfulEventCount"),
      dropped: total("distinctDroppedEventCount"),
      receivedAppends: memoryTelemetry.receivedPatchOperationsByType.append,
      appliedAppends: memoryTelemetry.newlyAppliedPatchOperationsByType.append,
    }, {
      invoked: 2,
      successful: 2,
      dropped: 0,
      receivedAppends: 2,
      appliedAppends: 2,
    });

    for (const session of [alice, bob]) {
      let rawLinkCount = 0;
      let projectedLinkCount = 0;
      for (const topicIndex of [0, 1]) {
        const rawLinks = await session.readRaw(["topics", topicIndex, "links"]);
        assert(Array.isArray(rawLinks));
        assertEquals(rawLinks.length, 1);
        rawLinkCount += rawLinks.length;

        const links = await session.read(["topics", topicIndex, "links"]);
        assert(Array.isArray(links));
        assertEquals(links.length, 1);
        projectedLinkCount += links.length;
      }
      assertEquals(rawLinkCount, 2);
      assertEquals(projectedLinkCount, 2);
    }

    await bob.telemetry();
    const title = await bob.read(["topics", 0, "title"]);
    const outcome = await bob.set(["topics", 0, "title"], title);
    assert(outcome.ok);
    const directTelemetry = await bob.telemetry();
    assertEquals(directTelemetry.distinctInvokedEventCount, 0);
    assertEquals(directTelemetry.distinctSuccessfulEventCount, 0);
    assertEquals(directTelemetry.distinctDroppedEventCount, 0);
    assertEquals(directTelemetry.droppedEventsByReason, {
      "piece-load": 0,
      lineage: 0,
      preflight: 0,
      "load-gate": 0,
    });
    assertEquals(directTelemetry.directCommitCount, 1);
    assertEquals(directTelemetry.changedWriteCount, 0);
    assert(directTelemetry.writeCount >= 1);

    const topic = await firstTopic(alice);
    const comments = topic.comments;
    assert(Array.isArray(comments));
    assert(isRecord(comments[0]));
    assertEquals(comments[0].body, "A nested stream invocation");

    const rawTopics = await alice.readRaw(["topics"]);
    assert(Array.isArray(rawTopics));
    assert(rawTopics.length >= 2);
    assert(
      rawTopics.every(isSigilLink),
      "Raw Topics entries must remain Fabric link sigils",
    );
    const reordered = [rawTopics[1], rawTopics[0], ...rawTopics.slice(2)];

    const before = await Promise.all(
      [alice, bob].map((session) => session.loggerCounts({ idle: false })),
    );
    harness.memoryTelemetry();
    await Promise.all(
      [alice, bob].map((session) =>
        session.prepareContainingDocumentValueRoot(
          ["topics"],
          reordered,
          { idle: false },
        )
      ),
    );
    const outcomes = await Promise.all(
      [alice, bob].map((session) =>
        session.commitPreparedContainingDocumentValueRoot()
      ),
    );
    assertEquals(outcomes.filter((outcome) => outcome.ok).length, 1);
    assertEquals(outcomes.filter((outcome) => !outcome.ok).length, 1);
    await harness.diagnosticsBarrier();

    assertEquals(await alice.readRaw(["topics"]), reordered);
    const topics = await alice.read(["topics"]);
    assert(Array.isArray(topics));
    assert(isRecord(topics[0]));
    assert(isRecord(topics[1]));
    const rootMemoryTelemetry = harness.memoryTelemetry();
    assert(rootMemoryTelemetry.acceptedCount >= 1);
    assert(rootMemoryTelemetry.conflictCount >= 1);
    assert(rootMemoryTelemetry.receivedCommitBytes.total > 0);
    assert(rootMemoryTelemetry.newlyPersistedRevisions.total > 0);
    assert((rootMemoryTelemetry.patchesByPathShape["value-root"] ?? 0) >= 1);
    const after = await Promise.all(
      [alice, bob].map((session) => session.loggerCounts({ idle: false })),
    );
    const counterDelta = (name: string): number =>
      after.reduce(
        (total, entry, index) =>
          total + (entry["storage.v2"]?.[name]?.total ?? 0) -
          (before[index]["storage.v2"]?.[name]?.total ?? 0),
        0,
      );
    assert(counterDelta("commit-conflict") > 0);
    assert(counterDelta("commit-revert") > 0);
  });
});
