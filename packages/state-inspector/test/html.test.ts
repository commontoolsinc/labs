// Hermetic test for the HTML explorer: the bundle carries rich per-entity
// details with context-aware labels (named streams, module imports), parsed CFC,
// and live-base passthrough; the rendered page is self-contained with a
// parseable, `</script>`-safe embedded bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { buildInspectorBundle, renderInspectorHtml } from "../html.ts";
import type { EntityDetail } from "../detail.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 6, 'active');
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

function link(id: string) {
  return { "/": { "link@1": { id, path: [] } } };
}

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  // module — carries CFC integrity, and a `</script>` guard in the source.
  commit.run(1, 1);
  rev.run(
    "of:mod",
    1,
    JSON.stringify({
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "// </script> guard\nexport default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
      cfc: {
        version: 1,
        schemaHash: "fid1:hash",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { integrity: ["cf-compiled-by:cf-compiler"] },
            origin: "declared",
          }],
        },
      },
    }),
    1,
  );
  // piece — value names an owned stream by the key `addNote`.
  commit.run(2, 2);
  rev.run(
    "of:piece",
    2,
    JSON.stringify({
      value: { $NAME: "My Notebook", $UI: {}, addNote: link("of:stream") },
      argument: link("of:input"),
      internal: [
        { partialCause: "q", link: link("of:owned") },
        { partialCause: "q", link: link("of:stream") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: {
        type: "object",
        properties: {
          // the `addNote` stream's payload schema lives here on the owner piece
          addNote: { $ref: "#/$defs/AddNoteEvent", asCell: ["stream"] },
        },
        $defs: {
          AddNoteEvent: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    }),
    2,
  );
  commit.run(3, 3);
  rev.run("of:input", 3, JSON.stringify({ value: { title: "t" } }), 3);
  commit.run(4, 4);
  rev.run(
    "of:owned",
    4,
    JSON.stringify({ value: "hi", result: link("of:piece") }),
    4,
  );
  commit.run(5, 5);
  rev.run(
    "of:stream",
    5,
    JSON.stringify({ value: { $stream: true }, result: link("of:piece") }),
    5,
  );
  // an import cell: { link, specifier }
  commit.run(6, 6);
  rev.run(
    "of:imp",
    6,
    JSON.stringify({ value: { link: link("of:mod"), specifier: "./dep.tsx" } }),
    6,
  );
  // a per-user-scoped cell — the multiplayer dimension the explorer must show.
  commit.run(7, 7);
  db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('of:pref', 'user:did%3Akey%3AzUser', 7, 0, 'set', ?, 7)`,
  ).run(JSON.stringify({ value: { theme: "dark" } }));
  db.close();
}

Deno.test("html explorer: rich bundle + self-contained render", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-html-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const bundle = buildInspectorBundle(space, {
        generatedAt: "2026-01-01",
        liveBase: "https://app.test",
      });
      const byId = (id: string): EntityDetail =>
        bundle.details.find((d) => d.id === id)!;

      await t.step("bundle carries rich per-entity details", () => {
        assert(bundle.details.length >= 5);
        assertEquals(bundle.liveBase, "https://app.test");
        assert(bundle.graph.edges.some((e) => e.kind === "pattern"));
        assert(bundle.timeline.length >= 1);

        const piece = byId("of:piece");
        assertEquals(piece.kind, "piece");
        assertEquals(piece.label, "My Notebook");
        assertEquals(piece.lineage.pattern?.id, "of:mod");
        assert(piece.schemaKeys?.includes("type"));
        assert(piece.versions.length >= 1);
      });

      await t.step("labels are context-aware (no bare stream / link)", () => {
        // A stream named by the piece's `addNote` key.
        const stream = byId("of:stream");
        assertEquals(stream.kind, "stream");
        assertEquals(stream.contextName, "addNote");
        assertEquals(stream.label, "⊙ addNote");
        // its payload schema is resolved from the owner piece's schema.
        assert(stream.streamPayload, "stream payload schema resolved");
        assert(
          stream.schemaKeys?.includes("properties"),
          "payload shape present",
        );
        assertStringIncludes(stream.schemaSource ?? "", "addNote");
        // A `{ link, specifier }` cell is a module import.
        const imp = byId("of:imp");
        assertEquals(imp.label, "import ./dep.tsx");
        assertEquals(imp.role, "module import");
      });

      await t.step("bundle surfaces per-identity scopes + overlays", () => {
        assert(
          bundle.scopes.some((s) => s.kind === "user"),
          "user scope enumerated",
        );
        const ov = bundle.overlays.find((o) => o.id === "of:pref");
        assert(ov, "per-user cell has a scope overlay");
        assertEquals(ov!.variants[0].kind, "user");
        // conflicts surface is present (single-session seed → none contested)
        assert(Array.isArray(bundle.conflicts));
        assert(Array.isArray(bundle.participants));
      });

      await t.step("CFC labels are parsed", () => {
        const mod = byId("of:mod");
        assert(mod.cfc, "module should carry cfc");
        assertEquals(mod.cfc!.schemaHash, "fid1:hash");
        assertEquals(mod.cfc!.entries[0].integrity, [
          "cf-compiled-by:cf-compiler",
        ]);
        assert(mod.code, "module should carry source");
      });

      await t.step("render is self-contained HTML", () => {
        const html = renderInspectorHtml(bundle);
        assertStringIncludes(html, "<!doctype html>");
        assertStringIncludes(html, bundle.space);
        assertStringIncludes(html, "My Notebook");
        // No external resources: all `<` in embedded data are escaped, so any
        // literal tag is ours — and none load a remote resource.
        assert(!html.includes("<script src"), "no external scripts");
        assert(!html.includes("<link "), "no external stylesheets");
      });

      await t.step("embedded bundle is parseable + script-safe", () => {
        const html = renderInspectorHtml(bundle);
        const m = html.match(
          /<script id="bundle" type="application\/json">(.*?)<\/script>/s,
        );
        assert(m, "bundle script block present");
        assert(!m![1].includes("</script>"), "payload must escape </script>");
        const parsed = JSON.parse(m![1].replaceAll("\\u003c", "<"));
        assertEquals(parsed.space, bundle.space);
        assertEquals(parsed.details.length, bundle.details.length);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
