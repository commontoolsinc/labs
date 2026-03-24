import { assert, assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  extendTrackedGraph,
  refreshTrackedGraph,
  trackGraph,
} from "../v2/query.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const invocationFor = (localSeq: number) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

Deno.test("memory v2 query retains a persistent memo for incremental watch growth", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-watch-growth";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assert(tracked.state.memo.size > 0);
    const memo = tracked.state.memo;
    const initialMemoSize = memo.size;

    const extended = extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: fixture.hiddenRootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assertEquals(tracked.state.memo, memo);
    assert(tracked.state.memo.size >= initialMemoSize);
    assert(
      [...extended.updates.values()].some((entity) =>
        entity.id === fixture.hiddenRootId
      ),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query uses a fresh memo for write-triggered refreshes", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-refresh";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    const growthMemo = tracked.state.memo;
    const growthMemoSize = growthMemo.size;

    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: fixture.expandedRootValue },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([fixture.rootId]),
    );
    assertExists(refreshed);
    assertEquals(tracked.state.memo, growthMemo);
    assertEquals(tracked.state.memo.size, growthMemoSize);

    assertEquals(
      [...refreshed.updates.values()].map((entity) => entity.id).sort(),
      fixture.expandedReachableIds,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
