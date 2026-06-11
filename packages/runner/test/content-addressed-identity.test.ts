import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { HarnessedFunction } from "../src/harness/types.ts";
import { trustModule } from "./support/trusted-builder.ts";

/**
 * PRs C and E1 of
 * docs/specs/content-addressed-action-identity-implementation-plan.md:
 * content-addressed `$implRef` + CFC provenance, and the writer flip.
 *
 * - Functions become "verified" by being registered through the trust-gated
 *   module indexing during evaluation; their provenance carries the defining
 *   module's content identity and the artifact's export/`__cfReg` symbol.
 * - Serialized javascript modules carry `$implRef: { identity, symbol }`;
 *   since the flip (E1) the legacy `implementationRef` is runtime-only and
 *   the body is omitted when the engine's strong implementation index proves
 *   the ref resolvable — including after the bounded artifact index evicts.
 * - CFC policy identity resolves from the provenance (`moduleIdentity`,
 *   reload-stable) with the legacy registry as fallback; a forged function —
 *   even with byte-identical source — has no provenance and fails closed.
 */

const signer = await Identity.fromPassphrase("content-addressed-identity");

const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const setName = handler<{ name?: string }, { name: Writable<string> }>(
  (event, state) => { state.name.set(event.name ?? ""); },
);

export default pattern(() => {
  const name = new Writable<string>("").for("name");
  return { name, setName: setName({ name }) };
});
`,
  }],
};

describe("content-addressed action identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const setup = async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    await runtime.idle();
    return pattern as Pattern;
  };

  const handlerModuleOf = (pattern: Pattern): Module => {
    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript" &&
      (n.module as Module).wrapper === "handler"
    );
    expect(node).toBeDefined();
    return node!.module as Module;
  };

  it("records provenance for compiled module-scope artifacts", async () => {
    const pattern = await setup();
    const module = handlerModuleOf(pattern);
    const fn = module.implementation as HarnessedFunction;
    expect(typeof fn).toBe("function");

    const provenance = getVerifiedProvenance(fn);
    expect(provenance).toBeDefined();
    expect(typeof provenance!.identity).toBe("string");
    expect(provenance!.identity.length).toBeGreaterThan(0);
    // The non-exported `bump` handler registers via the transformer's
    // `__cfReg` hoist; its symbol is the hoist/binding name.
    expect(typeof provenance!.symbol).toBe("string");
    // The canonical fn.src points into the same module identity.
    expect((fn as { src?: string }).src ?? "").toContain(
      `cf:module/${provenance!.identity}`,
    );
  });

  it("serializes javascript modules with $implRef only (no legacy fields)", async () => {
    const pattern = await setup();
    const module = handlerModuleOf(pattern);
    const json = (module as Module & { toJSON?: () => unknown }).toJSON
      ? (module as Module & { toJSON: () => unknown }).toJSON() as Record<
        string,
        unknown
      >
      : JSON.parse(JSON.stringify(module));

    const ref = json.$implRef as { identity: string; symbol: string };
    expect(ref).toBeDefined();
    const provenance = getVerifiedProvenance(
      module.implementation as HarnessedFunction,
    )!;
    expect(ref.identity).toBe(provenance.identity);
    expect(ref.symbol).toBe(provenance.symbol);
    // PR E1 (the flip): the legacy `implementationRef` is no longer written,
    // and the body stays omitted because this runtime's engine resolves the
    // `$implRef` through its content-addressed implementation index.
    expect("implementationRef" in json).toBe(false);
    expect("implementation" in json).toBe(false);
  });

  it("a $implRef-only module survives artifact-index eviction (engine implementation index)", async () => {
    const pattern = await setup();
    const module = handlerModuleOf(pattern);
    const json = (module as Module & { toJSON: () => unknown })
      .toJSON() as Record<string, unknown>;
    const ref = json.$implRef as { identity: string; symbol: string };
    expect(ref).toBeDefined();
    expect("implementation" in json).toBe(false);

    // The engine's implementation index admits the ref directly (this is the
    // strong, session-lifetime index that replaces the legacy registry's
    // eviction insurance for post-flip data).
    expect(
      typeof runtime!.harness.getVerifiedImplementation?.(
        ref.identity,
        ref.symbol,
      ),
    ).toBe("function");

    // Simulate the bounded artifact index rolling the module out mid-session
    // (FIFO eviction after ~1000 other identities) — the worst case for a
    // `$implRef`-only stored graph, which has no legacy ref and no body.
    const manager = runtime!.patternManager as unknown as {
      addressableByIdentity: Map<string, unknown>;
      modulesByIdentity: Map<string, unknown>;
    };
    manager.addressableByIdentity.clear();
    manager.modulesByIdentity.clear();
    expect(
      runtime!.patternManager.artifactFromIdentitySync(
        ref.identity,
        ref.symbol,
      ),
    ).toBeUndefined();

    // A graph carrying only the $implRef must still instantiate and execute.
    const nodes = pattern.nodes.map((node) =>
      (node.module as Module).type === "javascript" &&
        (node.module as Module).wrapper === "handler"
        ? { ...node, module: json as unknown as Module }
        : node
    );
    const rehydrated = { ...pattern, nodes } as unknown as Pattern;
    const tx = runtime!.edit();
    const resultCell = runtime!.getCell<{ name: string }>(
      signer.did(),
      "evicted-implref-resolution",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const r = runtime!.run(tx, rehydrated, {}, resultCell) as any;
    await tx.commit();
    await r.pull();
    r.key("setName").send({ name: "resolved-after-eviction" });
    await runtime!.idle();
    expect(r.key("name").get()).toBe("resolved-after-eviction");
  });

  it("in-action-created artifacts stay registry-admitted on the loadId-less path", async () => {
    // PR #4053 review finding (Codex P1 / cubic P2): a rehydrated
    // `$implRef`-only module resolves WITHOUT a verifiedLoadId, so the
    // dynamic-artifact registrar used to skip registry admission entirely —
    // an artifact minted DURING that action then serialized with a
    // stringified body and no ref at all, losing the live-closure
    // rehydration channel the legacy per-load registry provides on the
    // loadId-ful path. A `$implRef` cannot cover this category (dynamic
    // functions frequently have no canonical `fn.src` — action-time stacks
    // don't resolve under tamed SES), so the registrar now admits them into
    // the GLOBAL executable index under their minted content-derived ref,
    // keeping the pre-flip `{ implementationRef, body omitted }` serialized
    // form on both paths until E2's synthetic-identity registrar.
    const DYNAMIC_PROGRAM = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cf-disable-transform />
import { type Cell, handler, lift, pattern } from "commonfabric";

export const dump = handler<Record<string, never>, { out: Cell<string> }>(
  { type: "object", properties: {} },
  {
    type: "object",
    properties: { out: { type: "string", asCell: ["cell"] } },
    required: ["out"],
  },
  (_event, state) => {
    const base = 1;
    // Closure-bearing on purpose: a stringified round-trip would sever
    // \`base\`, so only registry admission rehydrates this correctly.
    const created = lift((value: number) => value + base);
    state.out.set(JSON.stringify(created));
  },
);

export default pattern<{ out: string }>(({ out }) => ({
  out,
  dump: dump({ out }),
}));
`,
      }],
    };
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    const pattern = await runtime.patternManager.compilePattern(
      DYNAMIC_PROGRAM,
    ) as Pattern;
    await runtime.idle();

    // Rehydrate the handler module from its serialized ($implRef-only) form
    // so resolution yields NO verifiedLoadId — the exact path the finding is
    // about.
    const module = handlerModuleOf(pattern);
    const json = (module as Module & { toJSON: () => unknown })
      .toJSON() as Record<string, unknown>;
    expect("implementationRef" in json).toBe(false);
    const nodes = pattern.nodes.map((node) =>
      (node.module as Module).type === "javascript" &&
        (node.module as Module).wrapper === "handler"
        ? { ...node, module: json as unknown as Module }
        : node
    );
    const rehydrated = { ...pattern, nodes } as unknown as Pattern;

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ out: string }>(
      signer.did(),
      "dynamic-artifact-loadid-less",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const r = runtime.run(tx, rehydrated, {}, resultCell) as any;
    await tx.commit();
    await r.pull();
    r.key("dump").send({});
    await runtime.idle();

    const dumped = JSON.parse(r.key("out").get() as string) as {
      $implRef?: { identity: string; symbol: string };
      implementationRef?: string;
      implementation?: string;
    };
    // The in-action artifact's serialized form: the legacy admitted shape —
    // minted content-derived ref, body omitted (matching the loadId-ful
    // path), no $implRef (no module-scope provenance symbol exists for it).
    expect(typeof dumped.implementationRef).toBe("string");
    expect("implementation" in dumped).toBe(false);
    expect("$implRef" in dumped).toBe(false);
    // ...and the ref resolves to the LIVE function through the global
    // executable index (the closure-preserving rehydration channel).
    expect(
      typeof runtime.harness.getExecutableFunction?.(
        dumped.implementationRef!,
      ),
    ).toBe("function");
  });

  it("CFC identity resolves from provenance with a stable moduleIdentity", async () => {
    const pattern = await setup();
    const module = handlerModuleOf(pattern);
    const fn = module.implementation as HarnessedFunction;

    const identity = resolvePolicyFacingImplementationIdentity(module, {
      harness: runtime!.harness,
      implementation: fn,
    });
    expect(identity).toBeDefined();
    expect(identity!.kind).toBe("verified");
    const verified = identity as {
      kind: "verified";
      moduleIdentity?: string;
      sourceLocation?: { line: number; column: number };
    };
    expect(verified.moduleIdentity).toBe(getVerifiedProvenance(fn)!.identity);
    expect(verified.sourceLocation).toBeDefined();
  });

  it("a forged function with identical source fails closed", async () => {
    const pattern = await setup();
    const module = handlerModuleOf(pattern);
    const fn = module.implementation as HarnessedFunction;

    // Byte-identical source text, constructed OUTSIDE verified evaluation:
    // no provenance entry, no registry entry — `unsupported`, never
    // `verified`.
    const forged = new Function(
      `return ${Function.prototype.toString.call(fn)}`,
    )() as HarnessedFunction;
    expect(getVerifiedProvenance(forged)).toBeUndefined();

    const identity = resolvePolicyFacingImplementationIdentity(module, {
      harness: runtime!.harness,
      verifiedLoadId: "load:forged",
      implementation: forged,
    });
    expect(identity?.kind).toBe("unsupported");
  });

  it("$implRef from a stale/foreign ref resolves nothing executable", async () => {
    await setup();
    // A ref pointing at an identity that was never evaluated resolves to
    // undefined in the index — the resolver falls back (legacy ref or
    // stringified source); it can never make non-builder data executable
    // because only trust-gated artifacts are indexed.
    const missing = runtime!.patternManager.artifactFromIdentitySync(
      "not-a-real-identity",
      "default",
    );
    expect(missing).toBeUndefined();
  });
});

describe("provenance bundleId fallback (legacy claim compat)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("falls back to verifiedLoadId when the bundle id is unregistered", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    await runtime.idle();
    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript" &&
      (n.module as Module).wrapper === "handler"
    );
    const module = node!.module as Module;
    const fn = module.implementation as HarnessedFunction;

    // A harness whose getVerifiedBundleId MISSES (legacy stamp-time scenario):
    // the resolved identity's bundleId must mirror the legacy resolver and
    // fall back to the raw verifiedLoadId, so a legacy bundleId-only
    // writeAuthorizedBy claim stamped with that value still verifies.
    const identity = resolvePolicyFacingImplementationIdentity(module, {
      harness: {
        getVerifiedBundleId: () => undefined,
      } as never,
      verifiedLoadId: "load:legacy-bundle",
      implementation: fn,
    });
    expect(identity?.kind).toBe("verified");
    expect((identity as { bundleId?: string }).bundleId).toBe(
      "load:legacy-bundle",
    );
  });

  it("carries the evaluation's bundleId via provenance when no verifiedLoadId is available", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    await runtime.idle();
    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript" &&
      (n.module as Module).wrapper === "handler"
    );
    const module = node!.module as Module;
    const fn = module.implementation as HarnessedFunction;

    // Post-flip stored graphs carry no `implementationRef`, so resolution of a
    // rehydrated module yields NO verifiedLoadId — but a stored legacy
    // bundleId-only `writeAuthorizedBy` claim still needs the live identity to
    // carry the bundle id or it fails closed. The id therefore rides on the
    // provenance recorded at evaluation time.
    expect(getVerifiedProvenance(fn)?.bundleId).toBeDefined();
    const identity = resolvePolicyFacingImplementationIdentity(module, {
      harness: runtime.harness,
      implementation: fn,
    });
    expect(identity?.kind).toBe("verified");
    expect((identity as { bundleId?: string }).bundleId).toBe(
      getVerifiedProvenance(fn)!.bundleId,
    );
  });
});

describe("$implRef resolution arm (Runner.resolveJavaScriptFunction)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // A lift makes the resolved executable's EFFECT observable through the
  // result value, so the assertion below proves the function actually RAN —
  // not merely that something resolved.
  const LIFT_PROGRAM = {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
import { lift, pattern } from "commonfabric";

export const double = lift((x: number) => x * 2);

export default pattern<{ value: number }>(({ value }) => ({
  doubled: double(value),
}));
`,
    }],
  };

  it("a module with ONLY $implRef (legacy ref and body stripped) resolves and executes", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    const pattern = await runtime.patternManager.compilePattern(
      LIFT_PROGRAM,
    ) as Pattern;
    await runtime.idle();

    // Serialize the compiled lift node's module the way a cell write would
    // (dual-write: $implRef alongside implementationRef), then strip the
    // legacy fields — the exact shape the planned flip produces (PR E of
    // docs/specs/content-addressed-action-identity-implementation-plan.md:
    // writers stop emitting implementationRef and the stringified
    // implementation).
    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript"
    );
    expect(node).toBeDefined();
    const live = node!.module as Module & { toJSON?: () => unknown };
    const json =
      (live.toJSON
        ? live.toJSON()
        : JSON.parse(JSON.stringify(live))) as Record<string, unknown>;
    const ref = json.$implRef as { identity: string; symbol: string };
    expect(ref).toBeDefined();
    delete json.implementationRef;
    delete json.implementation;

    // With both legacy fields gone, neither the legacy-registry arm (needs
    // module.implementationRef) nor the stringified-source fallback (needs
    // module.implementation; throws without it) can produce an executable.
    // Only `resolveByImplRef` can — by resolving the ref in the artifact
    // index. The functionCache cannot mask either: it keys on
    // implementationRef, so it neither prewarms nor caches this module.
    expect(
      runtime.patternManager.artifactFromIdentitySync(ref.identity, ref.symbol),
    ).toBeDefined();

    const stripped = trustModule(runtime, json as unknown as Module);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<number>(
      signer.did(),
      "implref-only-execution",
      undefined,
      tx,
    );
    const result = runtime.run(tx, stripped, 21, resultCell);
    await tx.commit();
    const out = await result.pull();
    // 21 → 42: the registered artifact's implementation ran via $implRef.
    expect(out).toBe(42);
  });
});
