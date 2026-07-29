import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getPatternIdentityRef, resolveEntryIdentity } from "../src/index.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// CT-1923 (2026-07-29 estuary): a running piece whose durable patternIdentity
// points at an identity this runtime CANNOT load sits stranded forever: the
// watcher sees the pointer as a change, fails the load, logs
// "pattern-load-error" — and leaves the unloadable pointer in place. Every
// later session then starts the piece by that dead pointer and renders
// nothing. Production shape: a nested home-section piece whose stored vintage
// used a retired JSX element; the parent re-instantiates the CURRENT
// sub-pattern each boot, but the durable pointer never rolls forward, so the
// stranded state reasserts itself per session (blank Favorites/Profile).
//
// Desired: with systemPatternAutoUpdate on, a DEFINITIVE load failure of the
// pointed-at identity (loadPatternByIdentity returns undefined after syncing
// — the docs are absent or do not compile) while a pattern is RUNNING rolls
// the pointer back to the running pattern's identity, durably. The stranded
// state becomes self-converging instead of self-perpetuating. Without the
// flag, behavior is unchanged (pointer left as written).

const signer = await Identity.fromPassphrase("pattern-pointer-unloadable");
const space = signer.did();

const V1 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v1' };",
  "});",
  "",
].join("\n");

// A well-formed content identity whose source closure is persisted NOWHERE in
// this store — the "obsolete vintage this runtime cannot load" stand-in.
const UNLOADABLE_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'unloadable-vintage' };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("unloadable patternIdentity pointer vs a running pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  const newRuntime = (systemPatternAutoUpdate: boolean) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { systemPatternAutoUpdate },
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    // Drain the watcher's floating load attempt (and any roll-forward
    // commit) before teardown so no promise is left pending at process exit
    // — Deno's event-loop check fails the whole shard otherwise.
    await rt?.idle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rt?.dispose();
    await storageManager?.close();
  });

  const runV1ThenStrandPointer = async () => {
    const unloadableIdentity = await resolveEntryIdentity(
      "/main.tsx",
      (name) =>
        name === "/main.tsx"
          ? Promise.resolve(UNLOADABLE_SOURCE)
          : Promise.reject(new Error(`not found: ${name}`)),
    );

    const tx = rt.edit();
    const v1 = await rt.patternManager.compilePattern(programOf(V1), {
      space,
      tx,
    });
    const v1Ref = rt.patternManager.getArtifactEntryRef(v1)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "unloadable-pointer-piece",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, {}, cell);
    await tx.commit();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
    expect(getPatternIdentityRef(cell)?.identity).toBe(v1Ref.identity);

    // The stranded durable state, however a session got there: pointer moved
    // to an identity that cannot load while V1 keeps running.
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: unloadableIdentity,
      symbol: "default",
    });
    await tx2.commit();
    await rt.idle();

    return { cell, v1Ref, unloadableIdentity };
  };

  // The watcher's load attempt and any roll-forward commit are floating
  // promises `rt.idle()` does not await; poll for the durable outcome.
  const settleUntil = async (
    predicate: () => boolean,
    timeoutMs = 3000,
  ): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };

  it("rolls the pointer back to the running identity (flag ON)", async () => {
    rt = newRuntime(true);
    const { cell, v1Ref } = await runV1ThenStrandPointer();

    const converged = await settleUntil(
      () => getPatternIdentityRef(cell)?.identity === v1Ref.identity,
    );
    expect(converged).toBe(true);
    const ref = getPatternIdentityRef(cell);
    expect(ref?.identity).toBe(v1Ref.identity);
    expect(ref?.symbol).toBe(v1Ref.symbol);
    // The running pattern was never torn down by the failed swap.
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
  });

  it("leaves the pointer as written when the flag is OFF", async () => {
    rt = newRuntime(false);
    const { cell, unloadableIdentity } = await runV1ThenStrandPointer();

    // Give a would-be roll-forward the same window the flag-ON case gets,
    // then assert nothing moved the pointer.
    await settleUntil(
      () => getPatternIdentityRef(cell)?.identity !== unloadableIdentity,
      500,
    );
    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
  });
});
