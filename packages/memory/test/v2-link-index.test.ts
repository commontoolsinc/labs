import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  type Engine,
  open,
  readIncomingLinks,
} from "../v2/engine.ts";
import { type EntityDocument } from "../v2.ts";

// Annotation primitive (prototype) — Phase 0 gate: the commit boundary walks
// each revised document for sigil links carrying a `linkRole` and maintains the
// reverse `link_index`. These tests exercise population, idempotence,
// retargeting, deletion, the patch path, and the negative cases (plain links
// and SourceLinks must not be indexed).

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const aboutLink = (id: string, role = "about") => ({
  "/": { "link@1": { id, linkRole: role } },
});

const plainLink = (id: string) => ({ "/": { "link@1": { id } } });

const toDoc = (value: unknown, extra: Record<string, unknown> = {}):
  EntityDocument => ({ ...extra, value } as EntityDocument);

const commitSet = (
  engine: Engine,
  localSeq: number,
  id: string,
  document: EntityDocument,
) =>
  applyCommit(engine, {
    sessionId: "session:alice",
    principal: "did:key:alice",
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: document }],
    },
  });

Deno.test("link_index: indexes an annotation about-edge at commit", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(
      engine,
      1,
      "annotation:1",
      toDoc({ rel: "comment", body: "Great work!", about: aboutLink("doc:1") }),
    );

    const incoming = readIncomingLinks(engine, { toId: "doc:1", role: "about" });
    assertEquals(incoming.length, 1);
    assertEquals(incoming[0].fromId, "annotation:1");
    assertEquals(incoming[0].role, "about");
    assertEquals(incoming[0].toId, "doc:1");
    assertEquals(incoming[0].fromPath, ["value", "about"]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: ignores sigil links without a linkRole", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(
      engine,
      1,
      "doc:2",
      toDoc({ ref: plainLink("doc:1") }),
    );
    assertEquals(readIncomingLinks(engine, { toId: "doc:1" }).length, 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: ignores SourceLink (string under '/')", async () => {
  const { engine, path } = await createEngine();
  try {
    // `source` is a SourceLink `{ "/": "<hash>" }` — a string under "/", which
    // must not be mistaken for a sigil link.
    commitSet(
      engine,
      1,
      "doc:3",
      toDoc({ note: "x" }, { source: { "/": "doc:1" } }),
    );
    assertEquals(readIncomingLinks(engine, { toId: "doc:1" }).length, 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: converging re-set is idempotent", async () => {
  const { engine, path } = await createEngine();
  try {
    const doc = toDoc({ rel: "tag", tag: "#alex", about: aboutLink("doc:1") });
    commitSet(engine, 1, "annotation:tag", doc);
    commitSet(engine, 2, "annotation:tag", doc);
    assertEquals(readIncomingLinks(engine, { toId: "doc:1", role: "about" }).length, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: retargeting moves the edge", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(engine, 1, "annotation:1", toDoc({ about: aboutLink("doc:A") }));
    commitSet(engine, 2, "annotation:1", toDoc({ about: aboutLink("doc:B") }));
    assertEquals(readIncomingLinks(engine, { toId: "doc:A", role: "about" }).length, 0);
    assertEquals(readIncomingLinks(engine, { toId: "doc:B", role: "about" }).length, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: delete clears edges", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(engine, 1, "annotation:1", toDoc({ about: aboutLink("doc:1") }));
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "annotation:1" }],
      },
    });
    assertEquals(readIncomingLinks(engine, { toId: "doc:1", role: "about" }).length, 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: patch adding an about-edge is indexed", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(engine, 1, "annotation:1", toDoc({ rel: "comment" }));
    assertEquals(readIncomingLinks(engine, { toId: "doc:1", role: "about" }).length, 0);
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "annotation:1",
          patches: [{ op: "add", path: "/value/about", value: aboutLink("doc:1") }],
        }],
      },
    });
    const incoming = readIncomingLinks(engine, { toId: "doc:1", role: "about" });
    assertEquals(incoming.length, 1);
    assertEquals(incoming[0].fromId, "annotation:1");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("link_index: multiple annotations on the same target accrete", async () => {
  const { engine, path } = await createEngine();
  try {
    commitSet(engine, 1, "annotation:1", toDoc({ body: "one", about: aboutLink("doc:1") }));
    commitSet(engine, 2, "annotation:2", toDoc({ body: "two", about: aboutLink("doc:1") }));
    const incoming = readIncomingLinks(engine, { toId: "doc:1", role: "about" });
    assertEquals(incoming.length, 2);
    assertEquals(
      incoming.map((l) => l.fromId).sort(),
      ["annotation:1", "annotation:2"],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
