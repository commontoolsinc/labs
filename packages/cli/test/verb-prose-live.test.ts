import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
import { executePieceCallable, listPieceCallables } from "../lib/piece.ts";
import { verbListingJson } from "../commands/piece.ts";

/**
 * One pattern documented the way an author is told to document one: the verb
 * says what it does where its `Stream` is declared, and each event field says
 * what it means where it is declared.
 *
 * Driven against a COMPILED, RUN pattern rather than a hand-built schema,
 * because the whole subject is what survives the compile pipeline and what
 * does not. A fixture asserting the shape by hand would agree with any
 * implementation, including the one that loses the prose: the two descriptions
 * below reach the pattern by two different routes — one as a sibling of the
 * verb property's `$ref`, one inside the `$defs` target that `$ref` names —
 * and only a real compile puts them where they actually land.
 *
 * `rename` carries no prose at all. It is the control: a verb an author has
 * not documented must gain no description, so an implementation that invents
 * one (the property's name, the event type's name, an empty string) fails
 * against it rather than passing everything.
 *
 * `AddEvent.urgent` is the other control, and it is the more interesting one.
 * It is declared, documented, and ABSENT from the schema the verb dispatches
 * through, because the handler's body never reads it and that schema is the
 * handler's read rather than the declared type. So the two documents this file
 * is about disagree on shape as well as on prose, and the assertion below pins
 * which one wins: the prose is folded into what a caller is served, never
 * served in its place.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent {",
      "  /** One line naming the work. */",
      "  title: string;",
      "  /** Whether to file it at the top of the board. */",
      "  urgent?: boolean;",
      "}",
      "",
      "interface RenameEvent { title: string; }",
      "",
      "interface Out {",
      "  /** Root items only. */",
      "  items: string[];",
      "  /** File a new root item on the board. */",
      "  add: Stream<AddEvent>;",
      "  rename: Stream<RenameEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<string[]>([]);",
      "  const add = action((event: AddEvent) => { items.push(event.title); });",
      "  const rename = action((event: RenameEvent) => {",
      "    items.set([event.title]);",
      "  });",
      "  return { items, add, rename };",
      "});",
    ].join("\n"),
  }],
};

const VERB_PROSE = "File a new root item on the board.";
const FIELD_PROSE = "One line naming the work.";

interface LivePiece {
  piece: unknown;
  space: string;
  dispose: () => Promise<void>;
}

/** Compile and run the program above, and hand back the piece surface both
 * caller-facing commands walk. */
async function runLivePiece(passphrase: string): Promise<LivePiece> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();
  const compiled = await runtime.patternManager.compilePattern(
    PROGRAM as never,
    { space },
  );
  const tx = runtime.edit();
  const rootCell = runtime.getCell(space, "verb-prose-live", undefined, tx);
  const root = runtime.run(tx, compiled, {}, rootCell);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit()).error).toBeUndefined();
  await root.pull();

  // `getResultCellWithSourceSchema` is the one narrowing `PiecesController`
  // applies before any `cf` command sees a piece; skipping it would hand the
  // lister a cell no caller is ever served.
  const result = getResultCellWithSourceSchema(root);
  return {
    space,
    piece: {
      result: { getCell: () => Promise.resolve(result) },
      input: {
        getCell: () =>
          Promise.resolve(runtime.getCell(space, "verb-prose-live-input")),
      },
      getCell: () => result,
      getPattern: () => Promise.resolve(compiled),
    },
    dispose: async () => {
      await runtime.dispose?.();
      await storageManager.close?.();
    },
  };
}

function configFor(space: string) {
  return {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:live",
    space,
  };
}

function depsFor(live: LivePiece) {
  return {
    loadPieces: () => Promise.resolve({ getSpace: () => live.space } as never),
    loadPiece: () => Promise.resolve(live.piece as never),
  };
}

/** The `cf piece verbs --json` payload, exactly as the command emits it. */
async function verbsJson(live: LivePiece): Promise<Record<string, unknown>> {
  const listing = await listPieceCallables(
    configFor(live.space),
    depsFor(live),
  );
  return verbListingJson(listing, false);
}

/** The `cf piece call <verb> --help --json` payload, as the command emits it. */
async function callHelpJson(
  live: LivePiece,
  verb: string,
): Promise<Record<string, unknown>> {
  const executed = await executePieceCallable(
    configFor(live.space),
    verb,
    ["--help", "--json"],
    depsFor(live),
  );
  return JSON.parse(executed.helpText ?? "{}");
}

/** The `cf piece call <verb> --help` text page. */
async function callHelpText(live: LivePiece, verb: string): Promise<string> {
  const executed = await executePieceCallable(
    configFor(live.space),
    verb,
    ["--help"],
    depsFor(live),
  );
  return executed.helpText ?? "";
}

function verbRow(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const verbs = payload.verbs as Record<string, unknown>[];
  const row = verbs.find((verb) => verb.name === name);
  expect(row).toBeDefined();
  return row!;
}

describe("an author's verb prose reaching a caller", () => {
  describe("cf piece verbs --json", () => {
    it("carries the verb's own doc comment as its description", async () => {
      const live = await runLivePiece("verb-prose-listing");
      try {
        expect(verbRow(await verbsJson(live), "add").description)
          .toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });

    it("carries an event field's doc comment in the row's input schema", async () => {
      const live = await runLivePiece("verb-prose-listing-field");
      try {
        const row = verbRow(await verbsJson(live), "add");
        expect(row.inputSchema).toMatchObject({
          properties: { title: { type: "string", description: FIELD_PROSE } },
        });
      } finally {
        await live.dispose();
      }
    });

    it("adds no property the dispatch schema does not carry", async () => {
      const live = await runLivePiece("verb-prose-listing-shape");
      try {
        const inputSchema = verbRow(await verbsJson(live), "add")
          .inputSchema as Record<string, unknown>;
        // `AddEvent.urgent` is declared and documented, and the schema the verb
        // dispatches through does not carry it: that schema is the handler's
        // read of the event, and this handler's body reads only `title`. The
        // pattern's prose must not paper over that — a caller offered
        // `--urgent` would be offered a flag the running handler ignores.
        //
        // This is what fails against the obvious implementation — merging the
        // declared event schema over the served one, or serving the declared
        // one in its place. Both would list `urgent`, and both would make this
        // listing a claim about the pattern's source rather than about the
        // piece a caller is talking to.
        expect(Object.keys(inputSchema.properties as object)).toEqual([
          "title",
        ]);
      } finally {
        await live.dispose();
      }
    });

    it("carries a description on the documented verb and not on its neighbor", async () => {
      const live = await runLivePiece("verb-prose-listing-undocumented");
      try {
        const payload = await verbsJson(live);
        // An implementation that supplies a description from anywhere but the
        // author's comment — the property name, the event type's name, an
        // empty string — fails on the first of these while passing every other
        // assertion in this file.
        expect("description" in verbRow(payload, "rename")).toBe(false);
        // And one that keys the prose by anything looser than the property
        // name — the first documented verb, say — fails on the second.
        expect(verbRow(payload, "add").description).toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });
  });

  describe("cf piece call --help --json", () => {
    it("carries the verb's own doc comment as its description", async () => {
      const live = await runLivePiece("verb-prose-help-json");
      try {
        expect((await callHelpJson(live, "add")).description).toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });

    it("carries an event field's doc comment in the served input schema", async () => {
      const live = await runLivePiece("verb-prose-help-json-field");
      try {
        expect((await callHelpJson(live, "add")).inputSchema).toMatchObject({
          properties: { title: { type: "string", description: FIELD_PROSE } },
        });
      } finally {
        await live.dispose();
      }
    });

    it("leaves an undocumented verb with no description", async () => {
      const live = await runLivePiece("verb-prose-help-json-undocumented");
      try {
        expect("description" in await callHelpJson(live, "rename")).toBe(false);
      } finally {
        await live.dispose();
      }
    });
  });

  describe("cf piece call --help", () => {
    it("prints the verb's own doc comment as the page's summary line", async () => {
      const live = await runLivePiece("verb-prose-help-text");
      try {
        const page = await callHelpText(live, "add");
        // Between Usage and JSON input, as a paragraph of its own: asserted as
        // a whole block rather than by containment, because the prose also
        // reaches the page through nothing else and a bare `toContain` would
        // pass against a page that printed it in the wrong place or twice.
        expect(page).toContain(`\n\n${VERB_PROSE}\n\nJSON input:\n`);
      } finally {
        await live.dispose();
      }
    });

    it("prints an event field's doc comment beside its flag", async () => {
      const live = await runLivePiece("verb-prose-help-text-field");
      try {
        expect(await callHelpText(live, "add"))
          .toContain(`--title <string>  Required. ${FIELD_PROSE}`);
      } finally {
        await live.dispose();
      }
    });

    it("prints no summary line for an undocumented verb", async () => {
      const live = await runLivePiece("verb-prose-help-text-undocumented");
      try {
        // Usage runs straight into JSON input, with no blank paragraph
        // standing where prose would be.
        expect(await callHelpText(live, "rename")).toContain(
          "\n\nJSON input:\n",
        );
        expect(await callHelpText(live, "rename")).not.toContain(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });
  });
});
