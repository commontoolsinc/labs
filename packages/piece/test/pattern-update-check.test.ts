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
import {
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
  checkPatternUpdate,
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
