/**
 * `PieceController.checkPattern` — the ahead-of-time verdict behind
 * `cf piece setsrc --check` — and the structured failure the enforced update
 * now reports.
 *
 * Why: the Estuary incident was a piece pinned to a pattern that could not
 * migrate its stored document, discovered only by attempting the swap and
 * reading a low-level rejection. These tests pin both halves of the fix: the
 * preflight answers the question without mutating anything, and a refused
 * update names the same reason the preflight would.
 *
 * CFC enforcement is ON (`enforce-explicit`) throughout, because the CFC
 * document-merge rules only run under an enforcing mode.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  type Cell,
  getPatternIdentityRef,
  type JSONSchema,
  type Pattern,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  explainUpdateFailure,
  pieceArgumentCellOrUndefined,
  retainedLinkVerdict,
  storedCfcEnvelopes,
} from "../src/ops/piece-controller.ts";
import {
  checkPatternUpdate,
  parseContractIssue,
  type PatternUpdateBlocker,
  type PatternUpdateCheckReport,
  PatternUpdateIncompatibleError,
} from "../src/pattern-update-check.ts";

const signer = await Identity.fromPassphrase("pattern update check");

const program = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

/** The running pattern: one optional input, one result field. */
const BASE = program(`/// <cts-enable />
import { Writable, pattern } from "commonfabric";

export default pattern<{ seed?: string }>(() => {
  const title = new Writable<string>("hi").for("title");
  return { title };
});
`);

/** Compatible evolution: a new OPTIONAL input the old caller never supplied. */
const ADDS_OPTIONAL_INPUT = program(`/// <cts-enable />
import { Writable, pattern } from "commonfabric";

export default pattern<{ seed?: string; nickname?: string }>(() => {
  const title = new Writable<string>("hi").for("title");
  return { title };
});
`);

/** Incompatible: a newly REQUIRED input field with no default. */
const ADDS_REQUIRED_INPUT = program(`/// <cts-enable />
import { Writable, pattern } from "commonfabric";

export default pattern<{ seed?: string; nickname: string }>(() => {
  const title = new Writable<string>("hi").for("title");
  return { title };
});
`);

/** Incompatible: an existing input field's type mutated. */
const MUTATES_INPUT_TYPE = program(`/// <cts-enable />
import { Writable, pattern } from "commonfabric";

export default pattern<{ seed?: number }>(() => {
  const title = new Writable<string>("hi").for("title");
  return { title };
});
`);

/** Compatible: adds a handler stream the old document has no marker for. */
const ADDS_HANDLER_STREAM = program(`/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const rename = handler<{ title: string }, { title: Writable<string> }>(
  (event, state) => {
    state.title.set(event.title);
  },
);

export default pattern<{ seed?: string }>(() => {
  const title = new Writable<string>("hi").for("title");
  return { title, rename: rename({ title }) };
});
`);

function patternOf(
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Pattern {
  return {
    argumentSchema,
    resultSchema,
    derivedInternalCells: [],
    result: {},
    nodes: [],
  };
}

describe("pattern update check", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const session = await createSession({
      identity: signer,
      spaceName: "pattern-update-check-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    pieces = new PiecesController(manager);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("accepts a compatible source and proves each rule it ran", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    const report = await piece.checkPattern(ADDS_OPTIONAL_INPUT);

    expect(report.compatible).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.piece).toBe(piece.id);
    expect(report.steps.map((step) => step.name)).toContain("pattern contract");
    expect(report.steps.map((step) => step.name)).toContain(
      "retained argument links",
    );
    // Every applicable step passed; none silently failed.
    expect(report.steps.some((step) => step.status === "fail")).toBe(false);
  });

  it("refuses a newly required INPUT field with no default, naming it", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    const report = await piece.checkPattern(ADDS_REQUIRED_INPUT);

    expect(report.compatible).toBe(false);
    const blocker = report.blockers.find((entry) =>
      entry.class === "pattern-contract"
    );
    expect(blocker).toBeDefined();
    expect(blocker!.role).toBe("argument");
    expect(blocker!.field).toBe("nickname");
    expect(blocker!.reason).toContain("newly required argument field");
    // Berni's framing: an added required INPUT genuinely needs a default,
    // because the pattern reads it and an existing caller never supplied it.
    expect(blocker!.message).toContain("input (argument)");
  });

  it("refuses an incompatible type mutation on an existing field", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    const report = await piece.checkPattern(MUTATES_INPUT_TYPE);

    expect(report.compatible).toBe(false);
    expect(report.blockers[0].class).toBe("pattern-contract");
    expect(report.blockers[0].field).toBe("seed");
    expect(report.blockers[0].reason).toMatch(/type|no longer accepts/);
  });

  it("reports a new handler stream as setup migration work", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    const report = await piece.checkPattern(ADDS_HANDLER_STREAM);

    const advisory = report.advisories.find((entry) =>
      entry.field === "rename"
    );
    expect(advisory).toBeDefined();
    expect(advisory!.class).toBe("setup-migration");
    expect(advisory!.message).toContain("stream marker");
    // The CFC document layer exempts a stream slot from its additive-required
    // rule (labs#4977), so nothing here is a CFC blocker.
    expect(
      report.blockers.filter((entry) => entry.class.startsWith("cfc-schema")),
    ).toEqual([]);
  });

  it("names the layer disagreement when a stream slot is refused", async () => {
    // Truthfulness over convenience: the pattern-contract proof has no stream
    // exemption, so `setsrc` DOES refuse a pattern that merely adds a handler.
    // The check reports what will happen and says which layer refused.
    const piece = await pieces.create(BASE, { input: {} });
    const report = await piece.checkPattern(ADDS_HANDLER_STREAM);

    expect(report.compatible).toBe(false);
    const blocker = report.blockers.find((entry) => entry.field === "rename");
    expect(blocker).toBeDefined();
    expect(blocker!.class).toBe("pattern-contract");
    expect(blocker!.streamSlot).toBe(true);
    expect(blocker!.message).toContain("only the pattern-contract proof");

    // And the enforced path agrees with the preflight, field for field.
    const error = await piece.setPattern(ADDS_HANDLER_STREAM).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PatternUpdateIncompatibleError);
    expect(
      (error as PatternUpdateIncompatibleError).blockers.map((entry) => ({
        class: entry.class,
        field: entry.field,
      })),
    ).toEqual(report.blockers.map((entry) => ({
      class: entry.class,
      field: entry.field,
    })));
  });

  it("mutates nothing, whatever the verdict", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    await manager.synced();
    const before = getPatternIdentityRef(piece.getCell());
    const beforeTitle = await piece.result.get(["title"]);

    expect((await piece.checkPattern(ADDS_OPTIONAL_INPUT)).compatible).toBe(
      true,
    );
    expect((await piece.checkPattern(ADDS_REQUIRED_INPUT)).compatible).toBe(
      false,
    );
    await runtime.idle();
    await manager.synced();

    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(await piece.result.get(["title"])).toEqual(beforeTitle);
  });

  it("refuses the real update with the same reason, leaving the piece intact", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    await manager.synced();
    const before = getPatternIdentityRef(piece.getCell());

    const error = await piece.setPattern(ADDS_REQUIRED_INPUT).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PatternUpdateIncompatibleError);
    const incompatible = error as PatternUpdateIncompatibleError;
    expect(incompatible.piece).toBe(piece.id);
    expect(
      incompatible.blockers.some((blocker) =>
        blocker.field === "nickname" && blocker.role === "argument"
      ),
    ).toBe(true);
    // The raw low-level assertion is still available as the cause, but the
    // message a user sees names the field and the rule.
    expect(incompatible.message).toContain("nickname");

    // Fail closed: the piece still runs its original pattern.
    await manager.synced();
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
  });

  it("still applies a compatible source", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    await manager.synced();
    const before = getPatternIdentityRef(piece.getCell());

    await piece.setPattern(ADDS_OPTIONAL_INPUT);
    await manager.synced();

    expect(getPatternIdentityRef(piece.getCell())).not.toEqual(before);
  });
});

describe("pattern update check — CFC document migration", () => {
  // The Estuary class, pinned at the layer that decides it. The stored envelope
  // is what the piece's document actually carries; the candidate is what the
  // incoming pattern would write. `checkPatternUpdate` drives the REAL CFC
  // merge over that pair, so this cannot drift from what a commit would do.
  const stored: JSONSchema = {
    type: "object",
    properties: { owner: { type: "string" } },
    required: ["owner"],
  };

  const previous = patternOf({ type: "object" }, stored);

  it("refuses a stored document that predates a now-required field", () => {
    const candidate = patternOf({ type: "object" }, {
      type: "object",
      properties: {
        owner: { type: "string" },
        favorites: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "favorites"],
    });

    const report = checkPatternUpdate({
      piece: "of:test",
      previous,
      candidate,
      storedCfcEnvelopes: { result: stored },
      retainedLinks: { ran: false },
    });

    expect(report.compatible).toBe(false);
    const blocker = report.blockers.find((entry) =>
      entry.class === "cfc-schema-migration"
    );
    expect(blocker).toBeDefined();
    expect(blocker!.field).toBe("favorites");
    expect(blocker!.reason).toContain(
      "required field favorites needs a default",
    );
    expect(blocker!.message).toContain("could not be read");
  });

  it("accepts the same field once it declares a default", () => {
    const candidate = patternOf({ type: "object" }, {
      type: "object",
      properties: {
        owner: { type: "string" },
        favorites: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["owner", "favorites"],
    });

    const report = checkPatternUpdate({
      piece: "of:test",
      previous,
      candidate,
      storedCfcEnvelopes: { result: stored },
      retainedLinks: { ran: false },
    });

    expect(
      report.blockers.filter((entry) => entry.class === "cfc-schema-migration"),
    ).toEqual([]);
  });

  it("exempts a newly required handler stream slot", () => {
    const candidate = patternOf({ type: "object" }, {
      type: "object",
      properties: {
        owner: { type: "string" },
        addFavorite: {
          type: "object",
          properties: {},
          asCell: ["stream"],
        },
      },
      required: ["owner", "addFavorite"],
    });

    const report = checkPatternUpdate({
      piece: "of:test",
      previous,
      candidate,
      storedCfcEnvelopes: { result: stored },
      retainedLinks: { ran: false },
    });

    expect(
      report.blockers.filter((entry) => entry.class.startsWith("cfc-schema")),
    ).toEqual([]);
    expect(report.advisories.some((entry) => entry.field === "addFavorite"))
      .toBe(true);
  });

  it("reports a non-migration merge rejection as its own class", () => {
    const candidate = patternOf({ type: "object" }, {
      type: "object",
      properties: { owner: { type: "number" } },
      required: ["owner"],
    });

    const report = checkPatternUpdate({
      piece: "of:test",
      previous,
      candidate,
      storedCfcEnvelopes: { result: stored },
      retainedLinks: { ran: false },
    });

    expect(report.compatible).toBe(false);
    expect(
      report.blockers.some((entry) => entry.class === "cfc-schema-merge"),
    ).toBe(true);
  });

  it("marks the CFC step not-applicable when no envelope is stored", () => {
    const report = checkPatternUpdate({
      piece: "of:test",
      previous,
      candidate: previous,
      storedCfcEnvelopes: {},
      retainedLinks: { ran: false, note: "no argument cell" },
    });

    expect(report.compatible).toBe(true);
    const cfcSteps = report.steps.filter((step) =>
      step.name.startsWith("CFC document migration")
    );
    expect(cfcSteps.length).toBe(2);
    expect(cfcSteps.every((step) => step.status === "not-applicable")).toBe(
      true,
    );
  });
});

describe("pattern update check — findings that name no field", () => {
  // A contract issue does not always come with a `role.field` path: a schema
  // that cannot even be validated is reported against the pattern as a whole.
  // Such a blocker must still read as a full sentence, and must not be run
  // through the stream-slot annotation (there is no field to look up).
  const wellFormed = patternOf({ type: "object" }, { type: "object" });

  it("reports an unvalidatable schema against the pattern, not a field", () => {
    const candidate = patternOf(
      {
        type: "object",
        properties: { seed: { $ref: "#/definitions/absent" } },
      },
      { type: "object" },
    );

    const report = checkPatternUpdate({
      piece: "of:test",
      previous: wellFormed,
      candidate,
      storedCfcEnvelopes: {},
      retainedLinks: { ran: false },
    });

    expect(report.compatible).toBe(false);
    const blocker = report.blockers[0];
    expect(blocker.class).toBe("pattern-contract");
    expect(blocker.field).toBeUndefined();
    expect(blocker.role).toBeUndefined();
    // No field means no stream-slot lookup, so the annotation must not fire.
    expect(blocker.streamSlot).toBeUndefined();
    expect(blocker.message).toContain("invalid schema");
    // Still a full sentence a CLI can print on its own line.
    expect(blocker.message).toMatch(/ — .+\.$/);
  });

  it("parses a bare reason that carries no path at all", () => {
    const blocker = parseContractIssue("something went sideways");

    expect(blocker.class).toBe("pattern-contract");
    expect(blocker.path).toBeUndefined();
    expect(blocker.field).toBeUndefined();
    expect(blocker.reason).toBe("something went sideways");
    expect(blocker.message).toBe("pattern — something went sideways.");
  });

  it("survives a pattern that declares no schemas at all", () => {
    // `argumentSchema`/`resultSchema` are optional on a compiled pattern, and
    // the advisory scan must not assume an object is there to read properties
    // off. Whatever the verdict, producing one must not throw.
    const bare = {
      derivedInternalCells: [],
      result: {},
      nodes: [],
    } as unknown as Pattern;

    const report = checkPatternUpdate({
      piece: "of:test",
      previous: bare,
      candidate: bare,
      storedCfcEnvelopes: {},
      retainedLinks: { ran: false },
    });

    expect(report.piece).toBe("of:test");
    expect(report.advisories).toEqual([]);
  });
});

describe("pattern update check — stream slot advisories", () => {
  const stream: JSONSchema = {
    type: "object",
    properties: {},
    asCell: ["stream"],
  };

  it("reports a stream slot the running pattern did not declare", () => {
    const report = checkPatternUpdate({
      piece: "of:test",
      previous: patternOf({ type: "object" }, { type: "object" }),
      candidate: patternOf({ type: "object" }, {
        type: "object",
        properties: { rename: stream },
      }),
      storedCfcEnvelopes: {},
      retainedLinks: { ran: false },
    });

    expect(report.advisories.map((entry) => entry.field)).toEqual(["rename"]);
    expect(report.advisories[0].role).toBe("result");
  });

  it("stays quiet about a stream slot that was already there", () => {
    // Setup materializes a stream marker on every run, so a slot the running
    // pattern already declares is not migration work worth reporting.
    const withStream = patternOf({ type: "object" }, {
      type: "object",
      properties: { rename: stream },
    });

    const report = checkPatternUpdate({
      piece: "of:test",
      previous: withStream,
      candidate: withStream,
      storedCfcEnvelopes: {},
      retainedLinks: { ran: false },
    });

    expect(report.advisories).toEqual([]);
  });
});

describe("pattern update check — gathering the piece's side of the verdict", () => {
  // The three read-only gatherers behind `checkPattern`. Their absent /
  // unreadable branches decide whether a rule reports "not applicable" or a
  // blocker, so each is driven here against real cells rather than inferred.
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const session = await createSession({
      identity: signer,
      spaceName: "pattern-update-gather-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    pieces = new PiecesController(manager);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves a piece's argument cell", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    expect(pieceArgumentCellOrUndefined(manager, piece.getCell()))
      .toBeDefined();
  });

  it("reports no argument cell for a document that has none", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    // The argument document itself carries no `argument` metadata link, so it
    // stands in for a piece that has none: `getArgument` throws, and the
    // gatherer must answer "absent" rather than propagate.
    const argument = pieceArgumentCellOrUndefined(manager, piece.getCell())!;
    expect(pieceArgumentCellOrUndefined(manager, argument)).toBeUndefined();
  });

  it("skips a role whose cell is absent", () => {
    expect(storedCfcEnvelopes(manager, [["argument", undefined]])).toEqual({});
  });

  it("skips a role whose envelope cannot be read", () => {
    const unreadable = {
      getAsNormalizedFullLink() {
        throw new Error("document unavailable");
      },
    } as unknown as Cell<unknown>;

    expect(storedCfcEnvelopes(manager, [["result", unreadable]])).toEqual({});
  });

  it("skips a live document that stores no schema envelope", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    await manager.synced();

    // No envelope at rest means the CFC merge never runs for that role at
    // commit time, so the role is simply absent rather than guessed at.
    expect(
      storedCfcEnvelopes(manager, [
        ["result", piece.getCell()],
        ["argument", pieceArgumentCellOrUndefined(manager, piece.getCell())],
      ]),
    ).toEqual({});
  });

  it("loads the envelope a document's stored metadata names", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { owner: { type: "string" } } },
      true,
    );
    // The read side of a document that HAS a committed envelope: `cfc`
    // metadata naming a schema hash, and the content-addressed schema document
    // that hash resolves to.
    const stubbedManager = {
      runtime: {
        readTx: () => ({
          readOrThrow: (target: { id: string }) =>
            target.id.startsWith("cid:") ? { value: schema } : {
              version: 1,
              labelMap: { entries: [] },
              schemaHash: taggedHashString,
            },
        }),
      },
    } as unknown as PieceManager;
    const cell = {
      getAsNormalizedFullLink: () => ({
        space: "did:key:envelope-test",
        id: "of:piece",
        scope: undefined,
      }),
    } as unknown as Cell<unknown>;

    expect(storedCfcEnvelopes(stubbedManager, [["result", cell]])).toEqual({
      result: schema,
    });
  });

  it("marks the retained-link proof not-applicable with no argument cell", () => {
    const pattern = patternOf({ type: "object" }, { type: "object" });
    expect(retainedLinkVerdict(manager, undefined, pattern, pattern)).toEqual({
      ran: false,
      note: "this piece has no argument cell",
    });
  });

  it("runs the retained-link proof over a real argument cell", async () => {
    const piece = await pieces.create(BASE, { input: {} });
    await manager.synced();
    const argument = pieceArgumentCellOrUndefined(manager, piece.getCell());

    const verdict = retainedLinkVerdict(
      manager,
      argument,
      patternOf({ type: "object" }, { type: "object" }),
      patternOf({ type: "object" }, { type: "object" }),
    );

    expect(verdict.ran).toBe(true);
    expect(verdict.issue).toBeUndefined();
  });

  it("reports a retained-link proof that could not complete as an issue", () => {
    const broken = {
      getRaw() {
        throw new Error("argument document unavailable");
      },
    } as unknown as Cell<unknown>;
    const pattern = patternOf({ type: "object" }, { type: "object" });

    const verdict = retainedLinkVerdict(manager, broken, pattern, pattern);

    expect(verdict.ran).toBe(true);
    expect(verdict.issue).toContain("argument document unavailable");
  });

  it("stringifies a non-Error retained-link failure", () => {
    const broken = {
      getRaw() {
        throw "argument document vanished";
      },
    } as unknown as Cell<unknown>;
    const pattern = patternOf({ type: "object" }, { type: "object" });

    expect(retainedLinkVerdict(manager, broken, pattern, pattern).issue).toBe(
      "argument document vanished",
    );
  });
});

describe("pattern update check — explaining a refused update", () => {
  const blocker: PatternUpdateBlocker = {
    class: "cfc-schema-migration",
    role: "result",
    field: "favorites",
    reason: "required field favorites needs a default",
    message: "field `favorites` would become required but has no default.",
  };

  const reportWith = (
    blockers: PatternUpdateBlocker[],
  ): PatternUpdateCheckReport => ({
    piece: "of:test",
    compatible: blockers.length === 0,
    steps: [],
    blockers,
    advisories: [],
  });

  it("re-describes the failure with the blockers the check would report", () => {
    const cause = new Error("commit rejected");
    const explained = explainUpdateFailure(
      "of:test",
      cause,
      {},
      () => reportWith([blocker]),
    );

    expect(explained).toBeInstanceOf(PatternUpdateIncompatibleError);
    const incompatible = explained as PatternUpdateIncompatibleError;
    expect(incompatible.piece).toBe("of:test");
    expect(incompatible.blockers).toEqual([blocker]);
    expect(incompatible.cause).toBe(cause);
    // The low-level detail survives as a trailing line rather than being lost.
    expect(incompatible.message).toContain("commit rejected");
  });

  it("leaves the failure alone when the override skipped the gates", () => {
    const cause = new Error("commit rejected");
    let gathered = false;

    const explained = explainUpdateFailure(
      "of:test",
      cause,
      { dangerouslyAllowIncompatibleSchema: true },
      () => {
        gathered = true;
        return reportWith([blocker]);
      },
    );

    expect(explained).toBe(cause);
    // Attributing gate findings to a run that skipped the gates would be a
    // lie, and re-reading storage to produce them would be wasted work.
    expect(gathered).toBe(false);
  });

  it("does not re-wrap a failure that already names its blockers", () => {
    const cause = new PatternUpdateIncompatibleError("of:test", [blocker]);
    let gathered = false;

    const explained = explainUpdateFailure("of:test", cause, {}, () => {
      gathered = true;
      return reportWith([blocker]);
    });

    expect(explained).toBe(cause);
    expect(gathered).toBe(false);
  });

  it("keeps the original failure when the verdict itself cannot be gathered", () => {
    const cause = new Error("transport failure");

    const explained = explainUpdateFailure("of:test", cause, {}, () => {
      throw new Error("storage unavailable");
    });

    expect(explained).toBe(cause);
  });

  it("keeps the original failure when no rule was actually broken", () => {
    const cause = new Error("something else went wrong");

    expect(explainUpdateFailure("of:test", cause, {}, () => reportWith([])))
      .toBe(cause);
  });
});
