import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { schedulerImplementationFingerprint } from "../src/scheduler/run.ts";
import { getSchedulerActionId } from "../src/scheduler/diagnostics.ts";
import type { Action } from "../src/scheduler/types.ts";

// W2.11 — static identity for every canonical builtin. A raw builtin resolved
// through the canonical registry ref (runner.ts's `moduleRefName`) but outside
// the server-executable subset is stamped `implementationHash =
// cf:builtin/<id>:v1`, so its persisted fingerprint clears the servability
// fingerprint gate instead of falling to an `action:…` shape that classifies
// as `untrusted-implementation`. Identity is derived ONLY from the canonical
// ref, never from the caller-controlled debug label.

const signer = await Identity.fromPassphrase("runner-builtin-static-identity");
const space = signer.did();

const idState = () => ({
  anonymousActionIds: new WeakMap<Action, string>(),
  anonymousActionCounter: 0,
});

/** Capture every action registered with the scheduler during instantiation. */
function captureScheduledActions(runtime: Runtime): Action[] {
  const captured: Action[] = [];
  const sched = runtime.scheduler as unknown as {
    subscribe: (...args: unknown[]) => unknown;
  };
  const original = sched.subscribe.bind(sched);
  sched.subscribe = (...args: unknown[]) => {
    captured.push(args[0] as Action);
    return original(...args);
  };
  return captured;
}

function actionsForBuiltin(actions: Action[], debugName: string): Action[] {
  return actions.filter(
    (action) =>
      (action as { module?: { debugName?: string } }).module?.debugName ===
        debugName,
  );
}

describe("canonical builtin static identity (W2.11)", () => {
  let runtime: Runtime | undefined;
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("stamps a real map builtin node with cf:builtin/map:v1", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const captured = captureScheduledActions(runtime);

    // A JSX/expression `.map()` lowers to the `map` builtin, resolved through
    // the canonical registry ref — exactly the R3 offender shape.
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ items: number[] }>(({ items }) => {",
          "  const doubled = items.map((n: any) => n * 2);",
          "  return { doubled };",
          "});",
        ].join("\n"),
      }],
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, "map-identity", undefined, tx);
    const handle = runtime.run(tx, compiled, { items: [1, 2, 3] }, resultCell);
    await tx.commit();
    for (let k = 0; k < 6; k++) {
      await handle.pull();
      await runtime.idle();
    }

    // Sanity: the builtin actually ran (an empty match set must not pass).
    expect(resultCell.get()).toEqual({ doubled: [2, 4, 6] });

    const mapActions = actionsForBuiltin(captured, "map");
    expect(mapActions.length).toBeGreaterThan(0);
    for (const action of mapActions) {
      expect((action as { implementationHash?: string }).implementationHash)
        .toBe("cf:builtin/map:v1");
      // The persisted fingerprint the servability gate reads.
      expect(schedulerImplementationFingerprint(action, "unused", undefined))
        .toBe("impl:cf:builtin/map:v1");
      // The scheduler action id now keys off the stamp + per-instance key.
      expect(getSchedulerActionId(idState(), action)).toMatch(
        /^cf:builtin\/map:v1:/,
      );
    }
  });

  it("stamps any canonical registry ref outside the server subset", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    // A registry ref the server subset does not cover: the generalized stamp
    // must cover every canonical builtin, not just the enumerated real ones.
    runtime.moduleRegistry.addModuleByRef(
      "cfTestComputation",
      raw((_inputsCell, sendResult) => (tx) => sendResult(tx, { ok: true })),
    );
    const captured = captureScheduledActions(runtime);

    const { commonfabric } = createTrustedBuilder(runtime);
    const testPattern = commonfabric.pattern<{ n: number }>(({ n }) =>
      commonfabric.byRef<{ n: number }, { ok: boolean }>("cfTestComputation")({
        n,
      })
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, "ref-identity", undefined, tx);
    const handle = runtime.run(tx, testPattern, { n: 1 }, resultCell);
    await tx.commit();
    await handle.pull();
    await runtime.idle();

    const builtinActions = actionsForBuiltin(captured, "cfTestComputation");
    expect(builtinActions.length).toBeGreaterThan(0);
    for (const action of builtinActions) {
      expect((action as { implementationHash?: string }).implementationHash)
        .toBe("cf:builtin/cfTestComputation:v1");
    }
  });

  it("does NOT stamp a raw module lacking a canonical ref, even with a builtin-shaped debug label", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const captured = captureScheduledActions(runtime);

    // A raw module run directly (never resolved through the registry ref) whose
    // caller-controlled debug metadata impersonates a canonical builtin: the
    // function is named `map` AND its module carries debugName `map`, the two
    // highest-priority `rawTargetName` fallbacks. Identity must key ONLY on the
    // canonical `moduleRefName` (absent here), never this forgeable label — so
    // no builtin identity is minted.
    const forged = raw(function map(_inputsCell, sendResult) {
      return (tx: Parameters<typeof sendResult>[0]) =>
        sendResult(tx, { ok: true });
    });
    (forged as unknown as { debugName?: string }).debugName = "map";

    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, "forged-identity", undefined, tx);
    runtime.runner.run(tx, forged, {}, resultCell);
    await tx.commit();
    await runtime.idle();

    const forgedActions = actionsForBuiltin(captured, "map");
    expect(forgedActions.length).toBeGreaterThan(0);
    for (const action of forgedActions) {
      const hash = (action as { implementationHash?: string })
        .implementationHash;
      expect(hash).not.toBe("cf:builtin/map:v1");
      expect(hash).toBeUndefined();
      // Falls through to today's telemetry fingerprint — the honest "no
      // trusted implementation identity" shape.
      expect(schedulerImplementationFingerprint(action, "unused", undefined))
        .toMatch(/^action:/);
    }
  });
});
