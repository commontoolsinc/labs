// A Writable declared USER-scoped at instantiation — by the pattern's
// argument SCHEMA (`PerUser<…>`) or by the LINK the caller passes for
// the slot — must never write to the SPACE address (RULED 2026-08-17:
// "a Writable scoped to user at declaration (either schema or the
// passed in link) should not write to space? that would be a clear yes,
// but also a serious problem on main right now").
//
// The bug this pins (found building fan-out stage B's transient-demander
// E2E; characterized by the independent review as posture-independent):
// a piece instantiated over an EXISTING argument document handed in as a
// cell never had its declared-scope slots narrowed — the eager
// scoped-key redirect (data-updating.ts) fires only when a parent object
// is written THROUGH the argument schema, and a doc-cell argument is a
// redirect link, not a value written through it. So the first handler
// write to `draft` (schema `Writable<string>`, no scope of its own)
// resolved the slot at the doc's base scope and landed Alice's per-user
// draft on the SPACE row, where Bob's client read it: a confidentiality
// leak, byte-identical OFF and ON, client-only, no server involved.
//
// The ruled seat: INSTANTIATION-TIME PRE-NARROWING — the runner's setup
// path applies the argument schema's eager scoped keys to the argument
// document whether it was handed a value or a link, so the first write
// already lands at the user address. This is a deliberate OFF-arm
// behavior change (recorded acceptance: declared-scope Writables no
// longer write to space; that write was a leak).
//
// Every arm here is the OFF arm — no `experimental.serverExecution`, no
// host: the shared in-process memory server exists only so a SECOND
// client (Bob) can read what Alice's handler wrote.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("scoped slot space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("scoped slot alice");
const bobSigner = await Identity.fromPassphrase("scoped slot bob");

/** The SCHEMA-declared shape: the argument type says `PerUser<Draft>`;
 * the handler's own input schema is a plain `Writable<string>`. */
const SCHEMA_DECLARED = [
  "import { computed, Default, handler, pattern, PerUser, Stream, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const draftText = (draft: Draft): string =>",
  "  (draft.get() as string | undefined) ?? '';",
  "const type = handler<{ text: string }, { draft: Draft }>(",
  "  (ev, { draft }) => { draft.set(ev.text); },",
  ");",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; n?: number },",
  "  { echo: string; type: Stream<{ text: string }> }",
  ">(({ draft, n }) => {",
  "  const draftCell: Draft = draft!;",
  "  return {",
  "    echo: computed(() => 'echo:' + draftText(draftCell)),",
  "    type: type({ draft: draftCell }),",
  "  };",
  "});",
].join("\n");

/** The LINK-declared shape: the argument type declares NO scope; the
 * caller passes a user-scoped cell for the slot. */
const LINK_DECLARED = [
  "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const draftText = (draft: Draft): string =>",
  "  (draft.get() as string | undefined) ?? '';",
  "const type = handler<{ text: string }, { draft: Draft }>(",
  "  (ev, { draft }) => { draft.set(ev.text); },",
  ");",
  "export default pattern<",
  "  { draft: Draft; n?: number },",
  "  { echo: string; type: Stream<{ text: string }> }",
  ">(({ draft, n }) => {",
  "  return {",
  "    echo: computed(() => 'echo:' + draftText(draft)),",
  "    type: type({ draft }),",
  "  };",
  "});",
].join("\n");

const SECRET = "SECRET-A";

const rowsUnder = (
  engine: Engine.Engine,
  scopeKey: string,
): Map<string, unknown> => {
  const rows = engine.database.prepare(
    `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
  ).all({ scope_key: scopeKey }) as Array<{ id: string }>;
  const out = new Map<string, unknown>();
  for (const { id } of rows) {
    out.set(id, Engine.read(engine, { id, scopeKey } as never)?.value);
  }
  return out;
};
const holdsSecret = (value: unknown): boolean =>
  JSON.stringify(value ?? null).includes(SECRET);

describe("declared-scope Writables never write to the space address (RULED 2026-08-17): instantiation-time pre-narrowing", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });
  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  /** OFF-arm client: no server execution, no host. */
  const openClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  const fireType = async (
    runtime: Runtime,
    result: ReturnType<Runtime["getCell"]>,
  ) => {
    (result.key("type") as unknown as { send(value: unknown): unknown })
      .send({ text: SECRET });
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** Where did Alice's write land, and what does Bob see? */
  const assertConfined = async (
    engine: Engine.Engine,
    argId: string,
    argSchema: unknown,
    argName: unknown,
    alice: Runtime,
    aliceResult: ReturnType<Runtime["getCell"]>,
  ) => {
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const spaceRow = rowsUnder(engine, "space").get(argId);
    const aliceRow = rowsUnder(engine, aliceKey).get(argId);
    // Alice's write is under HER user instance …
    expect(holdsSecret(aliceRow)).toBe(true);
    // … and NOT on the shared space row.
    expect(holdsSecret(spaceRow)).toBe(false);
    // Alice reads her own draft back through the piece (round trip): the
    // computed is pull-scheduled, so demand it first.
    const echo = aliceResult.key("echo") as unknown as {
      get(): unknown;
      sink(cb: (v: unknown) => void): () => void;
    };
    const cancelEcho = echo.sink(() => {});
    try {
      await alice.idle();
      expect(echo.get()).toBe(`echo:${SECRET}`);
    } finally {
      cancelEcho();
    }
    // Bob — a second client — cannot read it: neither the raw row nor a
    // typed read through the argument schema surfaces Alice's draft.
    const bob = openClient(bobSigner);
    const bobArg = bob.getCell<Record<string, unknown>>(
      space,
      argName as never,
      undefined,
    );
    await bobArg.sync();
    expect(holdsSecret(bobArg.get())).toBe(false);
    const bobTyped = bob.getCell<{ draft?: string }>(
      space,
      argName as never,
      argSchema as never,
    );
    await bobTyped.sync();
    expect(bobTyped.key("draft").get() ?? "").not.toBe(SECRET);
    // Bob's own view of the piece's echo is not Alice's either.
    void alice;
  };

  it("SCHEMA-declared slot, argument handed in as an EXISTING doc cell (the leak's shape): Alice's handler write lands under her user instance, the space row stays clean, Bob cannot read it", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SCHEMA_DECLARED }],
    }, { space });
    const argName = "pn-schema-doc-arg";
    const arg = alice.getCell<Record<string, unknown>>(
      space,
      argName,
      undefined,
    );
    const result = alice.getCell<Record<string, unknown>>(
      space,
      "pn-schema-doc-result",
      compiled.resultSchema,
    );
    await arg.sync();
    await result.sync();
    {
      // A pre-existing, schema-less document: `draft` never narrowed.
      const seed = alice.edit();
      arg.withTx(seed).set({ n: 1 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, arg, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await fireType(alice, result);
    await assertConfined(
      engine,
      arg.getAsNormalizedFullLink().id,
      compiled.argumentSchema,
      argName,
      alice,
      result,
    );
  });

  it("SCHEMA-declared slot, argument handed in as a VALUE (the path that already narrowed eagerly — the two instantiation paths agree)", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SCHEMA_DECLARED }],
    }, { space });
    const result = alice.getCell<Record<string, unknown>>(
      space,
      "pn-schema-value-result",
      compiled.resultSchema,
    );
    await result.sync();
    {
      const tx = alice.edit();
      alice.run(tx, compiled, { n: 1 }, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await fireType(alice, result);
    // The argument doc is the piece's own meta document here.
    const argLink = result.getAsNormalizedFullLink();
    const argCell = alice.getCellFromLink<Record<string, unknown>>({
      ...argLink,
      path: [],
    });
    // Find the argument doc id through the result's meta.
    const argId = (
      (result as unknown as {
        getMetaRaw?: (k: string) => unknown;
      }).getMetaRaw?.("argument") as
        | { "/": { "link@1": { id?: string } } }
        | undefined
    )?.["/"]?.["link@1"]?.id ?? argLink.id;
    void argCell;
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    // The write is under Alice's user instance of the argument doc and
    // not on its space row.
    const aliceRows = rowsUnder(engine, aliceKey);
    const spaceRows = rowsUnder(engine, "space");
    expect([...aliceRows.values()].some(holdsSecret)).toBe(true);
    expect([...spaceRows.values()].some(holdsSecret)).toBe(false);
    void argId;
  });

  it("LINK-declared slot: the caller passes a USER-scoped cell for a slot whose schema declares no scope — Alice's handler write lands under her user instance of that cell's doc, never on its space row; Bob cannot read it", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_DECLARED }],
    }, { space });
    // The passed-in link: a user-scoped cell over an otherwise ordinary
    // (space-based) document name.
    const draftName = "pn-link-draft-doc";
    const draftDoc = alice.getCell<string>(
      space,
      draftName,
      { type: "string" },
      undefined,
      "user",
    );
    await draftDoc.sync();
    const result = alice.getCell<Record<string, unknown>>(
      space,
      "pn-link-result",
      compiled.resultSchema,
    );
    await result.sync();
    {
      const tx = alice.edit();
      alice.run(tx, compiled, { n: 1, draft: draftDoc }, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await fireType(alice, result);
    const draftId = draftDoc.getAsNormalizedFullLink().id;
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    expect(holdsSecret(rowsUnder(engine, aliceKey).get(draftId))).toBe(true);
    expect(holdsSecret(rowsUnder(engine, "space").get(draftId))).toBe(false);
    const bob = openClient(bobSigner);
    const bobDraft = bob.getCell<string>(space, draftName, undefined);
    await bobDraft.sync();
    expect(holdsSecret(bobDraft.get())).toBe(false);
  });

  it("LINK-declared slot STORED in a doc-cell argument: the existing argument document's slot already holds a user-scoped link — the handler write follows it to Alice's user instance, never the space row", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_DECLARED }],
    }, { space });
    const draftName = "pn-stored-link-draft-doc";
    const draftDoc = alice.getCell<string>(
      space,
      draftName,
      { type: "string" },
      undefined,
      "user",
    );
    await draftDoc.sync();
    const argName = "pn-stored-link-arg";
    const arg = alice.getCell<Record<string, unknown>>(
      space,
      argName,
      undefined,
    );
    const result = alice.getCell<Record<string, unknown>>(
      space,
      "pn-stored-link-result",
      compiled.resultSchema,
    );
    await arg.sync();
    await result.sync();
    {
      const seed = alice.edit();
      arg.withTx(seed).set({ n: 1, draft: draftDoc });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, arg, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await fireType(alice, result);
    const draftId = draftDoc.getAsNormalizedFullLink().id;
    const argId = arg.getAsNormalizedFullLink().id;
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    expect(holdsSecret(rowsUnder(engine, aliceKey).get(draftId))).toBe(true);
    expect(holdsSecret(rowsUnder(engine, "space").get(draftId))).toBe(false);
    expect(holdsSecret(rowsUnder(engine, "space").get(argId))).toBe(false);
    const bob = openClient(bobSigner);
    const bobDraft = bob.getCell<string>(space, draftName, undefined);
    await bobDraft.sync();
    expect(holdsSecret(bobDraft.get())).toBe(false);
  });
});
