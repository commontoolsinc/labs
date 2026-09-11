import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenResult,
  setServerExecutionConfig,
  type ViewInterest,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import { Server } from "../v2/server.ts";

const space = "did:key:z6Mk-view-space";
const principal = "did:key:z6Mk-view-reader";
const query = (id: string) => ({
  roots: [{ id, selector: { path: [], schema: false as const } }],
});
const watch = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: query(id),
});
const view = (revision = 0): ViewInterest => ({
  id: "screen",
  revision,
  query: query("of:render"),
  mode: "speculate",
  componentContractVersion: "1",
});

function response<T>(messages: ServerMessage[], requestId: string): T {
  const message = messages.find((candidate) =>
    candidate.type === "response" && candidate.requestId === requestId
  ) as ResponseMessage<T> | undefined;
  if (message?.ok === undefined) {
    throw new Error(`Request failed: ${message?.error?.message}`);
  }
  return message.ok;
}

describe("view interests", () => {
  let server: Server;
  let connection: ReturnType<Server["connect"]>;
  let messages: ServerMessage[];
  let sessionId: string;
  let requests: number;

  async function set(watches: WatchSpec[], views?: ViewInterest[]) {
    const requestId = `watch-${requests++}`;
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId,
      space,
      sessionId,
      watches,
      ...(views === undefined ? {} : { views }),
    }));
    return response<WatchSetResult>(messages, requestId).sync;
  }

  beforeEach(async () => {
    requests = 0;
    messages = [];
    server = new Server({
      store: new URL("memory://view-interests"),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: { audience: "did:key:z6Mk-view-audience" },
    });
    connection = server.connect((message) => messages.push(message));
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages[0] as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    sessionId = response<SessionOpenResult>(messages, "open").sessionId;
    const result = await server.transact({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ["of:ordinary", "of:render", "of:support"].map((id) => ({
          op: "set",
          id,
          value: { value: { label: id } },
        })),
      },
    });
    expect(result.error).toBeUndefined();
    setServerExecutionConfig(true);
  });

  afterEach(async () => {
    await server.close();
    resetServerExecutionConfig();
  });

  it("evaluates render demand once when adding supporting delivery", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
    });
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await set([]);
      const renderEvaluations = evaluations.calls.filter((call) =>
        call.args[1].some((watch) =>
          watch.kind === "graph" &&
          watch.query.roots.some((root) => root.id === "of:render")
        )
      );
      expect(renderEvaluations).toHaveLength(1);
    } finally {
      evaluations.restore();
    }
  });

  it("refreshes changed render and support documents without rebuilding the watch union", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
    });
    await server.flushSessions();
    messages.length = 0;
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      for (const id of ["of:render", "of:support"]) {
        await server.writeDocument(space, id, { label: "updated" });
      }
      await server.flushSessions();
      const ids = messages.flatMap((message) =>
        message.type === "session/effect"
          ? message.effect.upserts.map((entry) => entry.id)
          : []
      );
      expect(ids.toSorted()).toEqual(["of:render", "of:support"]);
      expect(evaluations.calls).toHaveLength(0);
      expect(server.demandedInstancesForSpace(space).map((entry) => entry.id))
        .not.toContain("of:support");
    } finally {
      evaluations.restore();
    }
  });

  it("ignores unrelated commits without rebuilding queries or resending a manifest", async () => {
    await set([], [view()]);
    await server.flushSessions();
    messages.length = 0;
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await server.writeDocument(space, "of:ordinary", { label: "updated" });
      await server.flushSessions();
      expect(evaluations.calls).toHaveLength(0);
      expect(messages.filter((message) => message.type === "session/effect"))
        .toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("updates visible link demand incrementally and retires unreachable misses", async () => {
    const linked = (id: string) => ({
      primary: { "/": { "link@1": { id, path: [], space } } },
    });
    await server.writeDocument(space, "of:render", linked("of:unborn"));
    await set([], [{
      ...view(),
      query: {
        roots: [{
          id: "of:render",
          selector: {
            path: [],
            schema: {
              type: "object",
              properties: {
                primary: {
                  type: "object",
                  properties: { label: { type: "string" } },
                },
              },
            },
          },
        }],
      },
    }]);
    await server.flushSessions();
    const demanded = () =>
      server.demandedInstancesForSpace(space).map((row) => row.id);
    expect(demanded()).toContain("of:unborn");
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await server.writeDocument(space, "of:render", linked("of:arriving"));
      await server.flushSessions();
      expect(demanded()).not.toContain("of:unborn");
      expect(demanded()).toContain("of:arriving");
      messages.length = 0;
      await server.writeDocument(space, "of:unborn", { label: "orphan" });
      await server.flushSessions();
      expect(messages.filter((message) => message.type === "session/effect"))
        .toHaveLength(0);
      await server.writeDocument(space, "of:arriving", { label: "visible" });
      await server.flushSessions();
      expect(
        messages.flatMap((message) =>
          message.type === "session/effect"
            ? message.effect.upserts.map((entry) => entry.id)
            : []
        ),
      ).toContain("of:arriving");
      expect(evaluations.calls).toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("retains detached views and marks them attached when the session resumes", async () => {
    await set([], [view()]);
    const initial = response<SessionOpenResult>(messages, "open");
    const [interest] = server.viewInterestsForSpace(space);
    expect(interest).toMatchObject({ attached: true });
    connection.close();
    expect(server.viewInterestsForSpace(space)).toEqual([
      { ...interest, attached: false },
    ]);
    connection = server.connect((message) => messages.push(message));
    const offset = messages.length;
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages[offset] as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "resume",
      space,
      session: {
        sessionId: initial.sessionId,
        sessionToken: initial.sessionToken,
      },
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    expect(response<SessionOpenResult>(messages, "resume").resumed).toBe(true);
    expect(server.viewInterestsForSpace(space)).toEqual([interest]);
  });

  it("keeps ordinary watch ownership independent of visible roots", async () => {
    const first = await set([watch("of:ordinary")], [view()]);
    expect(first.upserts.map((entry) => entry.id).toSorted()).toEqual([
      "of:ordinary",
      "of:render",
    ]);
    const ordinaryRemoved = await set([]);
    expect(ordinaryRemoved.upserts.map((entry) => entry.id)).toEqual([
      "of:render",
    ]);
    expect(server.viewInterestsForSpace(space)).toHaveLength(1);
    const viewRemoved = await set([watch("of:ordinary")], []);
    expect(viewRemoved.removes.map((entry) => entry.id)).toEqual(["of:render"]);
    expect(viewRemoved.upserts.map((entry) => entry.id)).toEqual([
      "of:ordinary",
    ]);
    expect(server.viewInterestsForSpace(space)).toHaveLength(0);
  });

  it("delivers selected support without adding execution demand", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);
    const selected = await set([]);
    expect(selected.upserts.map((entry) => entry.id).toSorted()).toEqual([
      "of:render",
      "of:support",
    ]);
    expect(server.demandedInstancesForSpace(space).map((row) => row.id))
      .toEqual(["of:render"]);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 2,
        delivery: [],
      }),
    ).toBe(true);
    const shrunk = await set([]);
    expect(shrunk.removes.map((entry) => entry.id)).toEqual(["of:support"]);
  });

  it("adds an ordinary watch without resending unchanged view documents", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);
    await set([]);
    await server.flushSessions();
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      const added = await server.watchAdd({
        type: "session.watch.add",
        requestId: "add-ordinary",
        space,
        sessionId,
        watches: [watch("of:ordinary")],
      });
      expect(added.error).toBeUndefined();
      expect(added.ok?.sync.upserts.map((entry) => entry.id)).toEqual([
        "of:ordinary",
      ]);
      expect(added.ok?.sync.viewPlans?.[0].generation).toBe(1);
      const unchanged = await server.watchAdd({
        type: "session.watch.add",
        requestId: "add-existing",
        space,
        sessionId,
        watches: [watch("of:ordinary")],
      });
      expect(unchanged.error).toBeUndefined();
      expect(unchanged.ok?.sync.upserts).toEqual([]);
      expect(
        server.demandedInstancesForSpace(space).map((row) => row.id).toSorted(),
      )
        .toEqual(["of:ordinary", "of:render"]);
      expect(evaluations.calls).toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("does not install staged view watch additions when a later query fails", async () => {
    await set([], [view()]);
    const failed = await server.watchAdd({
      type: "session.watch.add",
      requestId: "bad-add",
      space,
      sessionId,
      watches: [watch("of:ordinary"), {
        id: "invalid-schema",
        kind: "graph",
        query: {
          branch: "other",
          roots: [{
            id: "of:broken",
            selector: {
              path: [],
              schema: {
                $ref:
                  "cid:bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
              },
            },
          }],
        },
      }],
    });
    expect(failed.error).toBeDefined();
    expect(server.demandedInstancesForSpace(space).map((row) => row.id)).not
      .toContain("of:ordinary");
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: "good-add",
      space,
      sessionId,
      watches: [watch("of:ordinary")],
    });
    expect(added.error).toBeUndefined();
    expect(added.ok?.sync.upserts.map((entry) => entry.id)).toEqual([
      "of:ordinary",
    ]);
  });

  it("rejects results from replaced and removed views even when an id is reused", async () => {
    await set([], [view()]);
    const [first] = server.viewInterestsForSpace(space);
    await set([], [view(1)]);
    expect(
      await server.setViewSelection(space, first.handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
    const [second] = server.viewInterestsForSpace(space);
    await set([], []);
    await set([], [view(1)]);
    expect(
      await server.setViewSelection(space, second.handle, {
        generation: 2,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
  });

  it("rejects an older selection and accepts an identical replay", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    const selection = { generation: 2, delivery: [query("of:support")] };
    expect(await server.setViewSelection(space, handle, selection)).toBe(true);
    expect(await server.setViewSelection(space, handle, selection)).toBe(true);
    expect(
      await server.setViewSelection(space, handle, {
        ...selection,
        generation: 1,
      }),
    ).toBe(false);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 2,
        delivery: [],
      }),
    ).toBe(false);
  });

  it("emits plan changes when the delivered documents stay identical", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
      eligibleActions: ["first"],
    });
    await server.flushSessions();
    messages.length = 0;
    await server.setViewSelection(space, handle, {
      generation: 2,
      delivery: [query("of:support")],
      eligibleActions: ["second"],
    });
    await server.flushSessions();
    const effects = messages.filter((message) =>
      message.type === "session/effect"
    );
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    if (effect.type !== "session/effect") {
      throw new Error("Expected session effect");
    }
    expect(effect.effect.upserts).toEqual([]);
    expect(effect.effect.viewPlans?.[0].generation).toBe(2);
    expect(effect.effect.viewPlans?.[0].eligibleActions).toEqual(["second"]);
  });

  it("isolates a stored selection from its caller's later mutations", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    const selection = {
      generation: 1,
      delivery: [query("of:support")],
      eligibleActions: ["allowed"],
    };
    await server.setViewSelection(space, handle, selection);
    selection.eligibleActions.push("unpublished");
    selection.delivery.length = 0;
    const sync = await set([]);
    expect(sync.viewPlans?.[0].eligibleActions).toEqual(["allowed"]);
    expect(sync.upserts.map((upsert) => upsert.id)).toContain("of:support");
  });

  it("leaves the current delivery intact when a selection schema is invalid", async () => {
    await set([watch("of:ordinary")], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await expect(server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [{
        roots: [{
          id: "of:support",
          selector: {
            path: [],
            schema: {
              $ref:
                "cid:bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
            },
          },
        }],
      }],
    })).rejects.toThrow();
    const sync = await set([watch("of:ordinary")]);
    expect(sync.upserts.map((upsert) => upsert.id).toSorted()).toEqual([
      "of:ordinary",
      "of:render",
    ]);
  });

  it("refuses explicit foreign instance roots at the wire boundary", async () => {
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "invalid",
      space,
      sessionId,
      watches: [],
      views: [{
        ...view(),
        query: {
          roots: [{
            id: "of:render",
            entityScopeKey: "user:foreign",
            selector: { path: [] },
          }],
        },
      }],
    }));
    const message = messages.find((entry) =>
      entry.type === "response" && entry.requestId === "invalid"
    ) as ResponseMessage<unknown>;
    expect(message.error).toBeDefined();
    expect(server.viewInterestsForSpace(space)).toHaveLength(0);
  });
});
