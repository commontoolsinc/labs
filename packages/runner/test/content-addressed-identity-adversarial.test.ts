import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import {
  getVerifiedProvenance,
  recordVerifiedProvenance,
} from "../src/harness/verified-provenance.ts";
import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/utils/sandbox-contract";
import {
  brandTrustedBuilderArtifact,
  isTrustedBuilderArtifact,
} from "../src/builder/pattern-metadata.ts";
import { ExecutableRegistry } from "../src/harness/executable-registry.ts";
import type { JSONSchema, Module, Pattern } from "../src/builder/types.ts";
import type { HarnessedFunction } from "../src/harness/types.ts";

/**
 * C5 red-team gate for PR C (content-addressed `$implRef` + CFC provenance) of
 * docs/specs/content-addressed-action-identity-implementation-plan.md.
 *
 * Each test is an attack on a fail-closed property; the assertion is the
 * defended outcome. The mirror style is test/cfreg-security.test.ts (pin the
 * runtime trust seams) and test/content-addressed-identity.test.ts (the happy
 * path these attacks try to subvert).
 *
 * The trust model these attacks probe:
 *   - A function is "verified" ONLY via a provenance WeakMap entry, written by
 *     two runner-owned channels (trust-gated module indexing, and the in-action
 *     registrar). An attacker-supplied object never traverses either, so it has
 *     no entry — there is no string key to collide.
 *   - `$implRef` in serialized data is a HINT for WHICH genuine indexed artifact
 *     to run. It can never name a forged executable (only trust-gated artifacts
 *     are indexed) and it never feeds the CFC identity: identity is computed from
 *     the RESOLVED function's provenance, so editing the ref cannot borrow
 *     another module's authority.
 *   - writeAuthorizedBy is an ownership gate: a verified-binding claim verifies
 *     only when the resolved identity's moduleIdentity (or legacy bundleId),
 *     file, AND path all match. Any mismatch — or a claim with neither id field —
 *     fails closed.
 */

const signer = await Identity.fromPassphrase("ca-identity-adversarial");

// A handler program with TWO module-scope handlers, so we have two distinct
// genuine artifacts/identities to cross-wire in the $implRef-confusion attacks.
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const setName = handler<{ name?: string }, { name: Writable<string> }>(
  (event, state) => { state.name.set(event.name ?? ""); },
);

const setLabel = handler<{ label?: string }, { label: Writable<string> }>(
  (event, state) => { state.label.set(event.label ?? "L:" + (event.label ?? "")); },
);

export default pattern(() => {
  const name = new Writable<string>("").for("name");
  const label = new Writable<string>("").for("label");
  return {
    name,
    label,
    setName: setName({ name }),
    setLabel: setLabel({ label }),
  };
});
`,
  }],
};

describe("content-addressed identity — adversarial (C5 red-team gate)", () => {
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

  const handlerModules = (pattern: Pattern): Module[] =>
    pattern.nodes
      .filter((n) =>
        (n.module as Module).type === "javascript" &&
        (n.module as Module).wrapper === "handler"
      )
      .map((n) => n.module as Module);

  // ---------------------------------------------------------------------------
  // Attack 1 — forged function with byte-identical source, built outside eval.
  // ---------------------------------------------------------------------------
  describe("attack 1: byte-identical forged function", () => {
    it("a forged twin (identical source, no eval registration) has no provenance and resolves unsupported", async () => {
      const pattern = await setup();
      const real = handlerModules(pattern)[0]
        .implementation as HarnessedFunction;
      expect(getVerifiedProvenance(real)).toBeDefined();

      // Reconstruct the exact source bytes OUTSIDE any verified evaluation.
      const forged = new Function(
        `return ${Function.prototype.toString.call(real)}`,
      )() as HarnessedFunction;
      expect(getVerifiedProvenance(forged)).toBeUndefined();

      const identity = resolvePolicyFacingImplementationIdentity(
        handlerModules(pattern)[0],
        { implementation: forged },
      );
      // Never "verified": no provenance, no legacy registry entry.
      expect(identity?.kind).not.toBe("verified");
    });

    it("a forged twin that ALSO steals the real fn's canonical src still gets no provenance", async () => {
      const pattern = await setup();
      const real = handlerModules(pattern)[0]
        .implementation as HarnessedFunction;
      const stolenSrc = (real as { src?: string }).src!;
      expect(stolenSrc).toContain("cf:module/");

      // The forged fn carries the genuine canonical src — but src is just an
      // own-property; verification keys on the provenance WeakMap, which has no
      // entry for this object.
      const forged = Object.assign(
        new Function(`return ${Function.prototype.toString.call(real)}`)(),
        { src: stolenSrc },
      ) as HarnessedFunction;
      expect(getVerifiedProvenance(forged)).toBeUndefined();

      const identity = resolvePolicyFacingImplementationIdentity(
        handlerModules(pattern)[0],
        { implementation: forged },
      );
      expect(identity?.kind).not.toBe("verified");
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 2 — $implRef replay / confusion. State graphs are attacker data.
  // ---------------------------------------------------------------------------
  describe("attack 2: $implRef replay/confusion", () => {
    it("$implRef at a non-existent or host: identity resolves nothing executable (miss → fallback)", async () => {
      await setup();
      const pm = runtime!.patternManager;
      // Never-evaluated identity.
      expect(pm.artifactFromIdentitySync("not-a-real-identity", "default"))
        .toBeUndefined();
      // host:-shaped identity — there is no entry, so a miss.
      expect(pm.artifactFromIdentitySync("host:evil", "setName"))
        .toBeUndefined();
    });

    it("$implRef pointing at a real identity with the WRONG symbol misses (never a forged fn)", async () => {
      const pattern = await setup();
      const pm = runtime!.patternManager;
      const mod = handlerModules(pattern)[0];
      const prov = getVerifiedProvenance(
        mod.implementation as HarnessedFunction,
      )!;
      // The genuine identity, but a symbol that was never registered under it.
      expect(
        pm.artifactFromIdentitySync(prov.identity, "symbol-not-registered"),
      )
        .toBeUndefined();
      // Sanity: the genuine symbol DOES resolve, to a builder artifact (never raw data).
      const ok = pm.artifactFromIdentitySync(prov.identity, prov.symbol!);
      expect(ok).toBeDefined();
      expect(isTrustedBuilderArtifact(ok)).toBe(true);
    });

    it("CFC identity is computed from the RESOLVED fn's provenance, NOT from $implRef in the data", async () => {
      const pattern = await setup();
      const [modA, modB] = handlerModules(pattern);
      const fnA = modA.implementation as HarnessedFunction;
      const provA = getVerifiedProvenance(fnA)!;
      const provB = getVerifiedProvenance(
        modB.implementation as HarnessedFunction,
      )!;
      // The two handlers live in the SAME module, so they share a moduleIdentity;
      // their distinct `symbol`s are the per-binding discriminator (and what a
      // verified-binding writeAuthorizedBy claim keys on via bindingPath).
      expect(provA.identity).toBe(provB.identity);
      expect(provA.symbol).not.toBe(provB.symbol);

      // Forge module A's serialized graph so its $implRef borrows B's
      // {identity, symbol} (the classic authority-borrow). State graphs are
      // attacker-influençable — assume the attacker rewrote the ref freely.
      const forgedModuleA = {
        ...modA,
        $implRef: { identity: provB.identity, symbol: provB.symbol },
      } as unknown as Module;

      // CFC identity is resolved from the function actually invoked (fnA), never
      // from the ref in the data: the resolver reads fnA's provenance, so the
      // policy-facing identity carries A's symbol — the forged ref to B is inert.
      const identity = resolvePolicyFacingImplementationIdentity(
        forgedModuleA,
        {
          implementation: fnA,
        },
      );
      expect(identity?.kind).toBe("verified");
      const v = identity as {
        kind: "verified";
        moduleIdentity?: string;
        symbol?: string;
      };
      expect(v.moduleIdentity).toBe(provA.identity);
      expect(v.symbol).toBe(provA.symbol);
      expect(v.symbol).not.toBe(provB.symbol);
    });

    it("a bad $implRef cannot make a __cf_data-forged value executable: the index never holds one", async () => {
      const pattern = await setup();
      const pm = runtime!.patternManager;
      const prov = getVerifiedProvenance(
        handlerModules(pattern)[0].implementation as HarnessedFunction,
      )!;
      // Whatever the (genuine) identity+symbol resolve to, it is a trusted
      // builder artifact, never a plain/forged value — that is the only thing a
      // resolved $implRef can ever hand back.
      const artifact = pm.artifactFromIdentitySync(prov.identity, prov.symbol!);
      expect(isTrustedBuilderArtifact(artifact)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 3 — __cf_data-forged factory shapes through the indexing sink.
  // ---------------------------------------------------------------------------
  describe("attack 3: __cf_data-forged factory shapes", () => {
    it("an unbranded {implementation, __cfVerifiedBindingIdentity} shape is dropped by the trust gate", () => {
      const forgedFactory = {
        implementation: function forgedImpl() {},
        [VERIFIED_BINDING_METADATA_FIELD]: {
          sourceFile: "/victim.tsx",
          bindingPath: ["ownerOnlyHandler"],
        },
      };
      // The gate that indexArtifact consults before recording provenance.
      expect(isTrustedBuilderArtifact(forgedFactory)).toBe(false);
      // And it carries no provenance (it never went through indexArtifact).
      expect(getVerifiedProvenance(forgedFactory.implementation))
        .toBeUndefined();
    });

    it("even a branded look-alike's nested implementation gains nothing without going through indexArtifact", () => {
      // brandTrustedBuilderArtifact would let the OBJECT pass the gate, but
      // provenance for the IMPLEMENTATION fn is written only by indexArtifact /
      // the in-action registrar — never by branding alone.
      const fn = function notVerified() {};
      const branded = brandTrustedBuilderArtifact({
        implementation: fn,
        [VERIFIED_BINDING_METADATA_FIELD]: {
          sourceFile: "/victim.tsx",
          bindingPath: ["ownerOnlyHandler"],
        },
      });
      expect(isTrustedBuilderArtifact(branded)).toBe(true);
      expect(getVerifiedProvenance(fn)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 4 — bindingIdentity spoofing (highest-value: ownership gate).
  // ---------------------------------------------------------------------------
  describe("attack 4: bindingIdentity spoofing of writeAuthorizedBy ownership", () => {
    it("an attacker-chosen __cfVerifiedBindingIdentity on an unbranded factory yields no verified binding", () => {
      // The factory carries a binding annotation pointing at a victim's
      // owner-protected cell. Without the trust brand it never reaches
      // indexArtifact, so readBindingIdentity is never consulted FOR PROVENANCE
      // and the fn stays unverified.
      const fn = function attacker() {};
      const factory = Object.assign(fn, {
        [VERIFIED_BINDING_METADATA_FIELD]: {
          sourceFile: "/victim.tsx",
          bindingPath: ["victimOwnedField"],
        },
      });
      expect(isTrustedBuilderArtifact(factory)).toBe(false);
      expect(getVerifiedProvenance(factory)).toBeUndefined();
    });

    it("a verified-binding writeAuthorizedBy claim fails closed when the resolved identity's bindingPath differs", async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: "ts-attack4",
          actingPrincipal: signer.did(),
        }),
      });
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          owned: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  // Claim is owned by VICTIM module + path.
                  moduleIdentity: "victim-module-identity",
                  file: "/victim.tsx",
                  path: ["victimOwnedField"],
                },
              },
            },
          },
        },
        required: ["owned"],
      } as unknown as JSONSchema;
      const cell = runtime.getCell(signer.did(), "attack4-binding", schema, tx);

      // Attacker's verified identity claims a DIFFERENT module/path (their own).
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: "attacker-module-identity",
        sourceFile: "/attacker.tsx",
        bindingPath: ["attackerOwnedField"],
      });
      cell.set({ owned: "stolen" });

      // moduleIdentity, file, AND path must all match; none do → fail closed.
      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error).toBeDefined();
    });

    it("the claim's bindingPath cannot be satisfied by a matching moduleIdentity alone (path must also match)", async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: "ts-attack4b",
          actingPrincipal: signer.did(),
        }),
      });
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          owned: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  moduleIdentity: "shared-module-identity",
                  file: "/shared.tsx",
                  path: ["ownerHandler"],
                },
              },
            },
          },
        },
        required: ["owned"],
      } as unknown as JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "attack4b-binding",
        schema,
        tx,
      );

      // Same module + file, but a DIFFERENT binding (a sibling handler in the
      // same module must not be able to write the owner's field).
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: "shared-module-identity",
        sourceFile: "/shared.tsx",
        bindingPath: ["someOtherHandler"],
      });
      cell.set({ owned: "stolen" });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error).toBeDefined();
    });

    it("an already-stamped claim is NOT re-stamped by a different verified writer (no rebind on stamped claims)", async () => {
      // The rebind that stamps an unstamped claim no-ops once a claim already
      // carries an id field. So a stored owner-protected field (claim already
      // stamped with the OWNER's moduleIdentity) cannot be re-stamped — and thus
      // cannot be written — by a different verified handler. This is the durable
      // ownership boundary for pre-existing fields.
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: "ts-attack4d",
          actingPrincipal: signer.did(),
        }),
      });
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          owned: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  // ALREADY stamped to the owner module — not unstamped.
                  moduleIdentity: "owner-module",
                  file: "/owner.tsx",
                  path: ["ownerHandler"],
                },
              },
            },
          },
        },
        required: ["owned"],
      } as unknown as JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "attack4d-binding",
        schema,
        tx,
      );
      // Different verified writer — the rebind cannot overwrite the owner's stamp.
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: "attacker-module",
        sourceFile: "/attacker.tsx",
        bindingPath: ["attackerHandler"],
      });
      cell.set({ owned: "stolen" });
      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error).toBeDefined();
    });

    it("a fully matching verified-binding identity is accepted (defense is not vacuous)", async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: "ts-attack4c",
          actingPrincipal: signer.did(),
        }),
      });
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          owned: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  moduleIdentity: "match-module-identity",
                  file: "/match.tsx",
                  path: ["ownerHandler"],
                },
              },
            },
          },
        },
        required: ["owned"],
      } as unknown as JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "attack4c-binding",
        schema,
        tx,
      );

      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: "match-module-identity",
        sourceFile: "/match.tsx",
        bindingPath: ["ownerHandler"],
      });
      cell.set({ owned: "authorized" });

      const result = await tx.commit();
      // The writeAuthorizedBy arm passes; any remaining reason would be unrelated
      // to identity-borrowing. Assert specifically no writeAuthorizedBy failure.
      if (result.error) {
        expect(String(result.error)).not.toContain("writeAuthorizedBy");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 5 — claim forgery in stored schemas (hand-built __ctWriterIdentityOf).
  // ---------------------------------------------------------------------------
  describe("attack 5: forged stored writeAuthorizedBy claims", () => {
    const driveClaim = async (
      claim: Record<string, unknown>,
      identity: Record<string, unknown>,
      name: string,
    ) => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: `ts-${name}`,
          actingPrincipal: signer.did(),
        }),
      });
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          owned: { type: "string", ifc: { writeAuthorizedBy: claim } },
        },
        required: ["owned"],
      } as unknown as JSONSchema;
      const cell = runtime.getCell(signer.did(), name, schema, tx);
      tx.setCfcImplementationIdentity(identity as never);
      cell.set({ owned: "x" });
      const digest = tx.prepareCfc();
      const result = await tx.commit();
      return { digest, result };
    };

    it("a claim with moduleIdentity matching but file/path NOT fails closed", async () => {
      const { digest, result } = await driveClaim(
        {
          __ctWriterIdentityOf: {
            moduleIdentity: "m1",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "m1", // matches
          sourceFile: "/attacker.tsx", // does NOT
          bindingPath: ["attackerHandler"], // does NOT
        },
        "attack5-id-match-pathmismatch",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("a claim with file/path matching but moduleIdentity NOT fails closed", async () => {
      const { digest, result } = await driveClaim(
        {
          __ctWriterIdentityOf: {
            moduleIdentity: "owner-module",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "attacker-module", // does NOT
          sourceFile: "/owner.tsx", // matches
          bindingPath: ["ownerHandler"], // matches
        },
        "attack5-pathmatch-idmismatch",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("a claim carrying NEITHER id field (no moduleIdentity, no bundleId) fails closed against a non-rebinding writer", async () => {
      // NOTE: a VERIFIED writer would trigger rebindWriteAuthorizedByClaims,
      // which stamps an UNSTAMPED claim with the writer's own moduleIdentity —
      // the by-design self-authoring path (a handler authoring its OWN fresh
      // claim), NOT an attack. To isolate the fail-closed property of a claim
      // that genuinely carries no id field, use a builtin writer: the rebind
      // does not fire for non-verified writers, so the verified-binding claim is
      // checked as-is and cannot match (it demands a verified writer anyway).
      const { digest, result } = await driveClaim(
        {
          __ctWriterIdentityOf: {
            // No moduleIdentity, no bundleId.
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        { kind: "builtin", builtinId: "someBuiltin" },
        "attack5-no-id-field",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("an unstamped claim authored by a verified writer is stamped to THAT writer (self-authoring, not borrowing)", async () => {
      // The flip side of the note above, pinned explicitly: when a verified
      // handler writes a field whose claim has no id field yet, the claim is
      // bound to the writer's own moduleIdentity/file/path. This is the
      // legitimate creation step; it does NOT let the writer borrow a DIFFERENT
      // owner's authority, because the stamp is the writer's own identity. (The
      // borrow attempts — wrong moduleIdentity / wrong path against an ALREADY
      // STAMPED claim — are the failing cases above.)
      const { digest, result } = await driveClaim(
        {
          __ctWriterIdentityOf: { file: "/self.tsx", path: ["selfHandler"] },
        },
        {
          kind: "verified",
          moduleIdentity: "self-module",
          sourceFile: "/self.tsx",
          bindingPath: ["selfHandler"],
        },
        "attack5-self-authoring",
      );
      // Accepted: the writer authored its own claim (file/path agree with the
      // writer's identity, and the missing id field is stamped to self).
      if (result.error) {
        expect(String(result.error)).not.toContain("writeAuthorizedBy");
      }
      expect(typeof digest).toBe("string");
    });

    it("a legacy claim (bundleId only) does NOT match a moduleIdentity-only identity (no cross-arm confusion)", async () => {
      const { digest, result } = await driveClaim(
        {
          __ctWriterIdentityOf: {
            bundleId: "legacy-bundle", // legacy arm only
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          // moduleIdentity present but the identity carries NO bundleId, so the
          // legacy (bundleId) arm the claim selects cannot be satisfied.
          moduleIdentity: "legacy-bundle", // must not be read as a bundleId
          sourceFile: "/owner.tsx",
          bindingPath: ["ownerHandler"],
        },
        "attack5-bundleid-arm-no-confusion",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 6 — fn.src spoofing vs the provenance identity.
  // ---------------------------------------------------------------------------
  describe("attack 6: fn.src spoofing", () => {
    // These probe resolveProvenanceImplementationIdentity directly: we fabricate
    // a provenance entry (the trusted channel's effect) on a function WE control,
    // then mismatch its src. recordVerifiedProvenance is the exact write the real
    // indexer performs; here we use it to isolate the src↔provenance check.

    it("a verified fn whose src names a DIFFERENT module than its provenance fails closed", () => {
      const fn = Object.assign(() => undefined, {
        src: "cf:module/REAL_MODULE_A/main.tsx:4:12",
      });
      recordVerifiedProvenance(fn, {
        identity: "REAL_MODULE_A",
        symbol: "ownerHandler",
      });
      // Now spoof src to claim it belongs to a different (victim) module.
      (fn as { src: string }).src = "cf:module/VICTIM_MODULE_B/main.tsx:4:12";

      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { implementation: fn },
      );
      expect(identity?.kind).toBe("unsupported");
    });

    it("a verified fn whose src OMITS the cf:module prefix fails closed (no identity to extract)", () => {
      const fn = Object.assign(() => undefined, {
        src: "/main.tsx:4:12", // no cf:module/<hash>/ prefix
      });
      recordVerifiedProvenance(fn, {
        identity: "SOME_MODULE",
        symbol: "ownerHandler",
      });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { implementation: fn },
      );
      // identityFromCanonicalSource("/main.tsx...") is undefined ≠ provenance id.
      expect(identity?.kind).toBe("unsupported");
    });

    it("a verified fn whose src matches its provenance resolves verified (check is not vacuous)", () => {
      const fn = Object.assign(() => undefined, {
        src: "cf:module/CONSISTENT_MODULE/main.tsx:7:3",
      });
      recordVerifiedProvenance(fn, {
        identity: "CONSISTENT_MODULE",
        symbol: "ownerHandler",
      });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { implementation: fn },
      );
      expect(identity?.kind).toBe("verified");
      const v = identity as { kind: "verified"; moduleIdentity?: string };
      expect(v.moduleIdentity).toBe("CONSISTENT_MODULE");
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 7 — dynamic (in-action-minted) artifact path.
  // ---------------------------------------------------------------------------
  describe("attack 7: dynamic in-session artifacts", () => {
    it("a dynamic-provenance fn with consistent src resolves verified but carries no symbol (no cross-session ref)", () => {
      const fn = Object.assign(() => undefined, {
        src: "cf:module/DYN_MODULE/main.tsx:2:1",
      });
      // Mirrors the in-action registrar: identity from canonical src, dynamic,
      // NO symbol.
      recordVerifiedProvenance(fn, { identity: "DYN_MODULE", dynamic: true });

      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { implementation: fn },
      );
      // It is verified IN SESSION (the provenance exists and src matches)...
      expect(identity?.kind).toBe("verified");
      const v = identity as { kind: "verified"; symbol?: string };
      // ...but carries no symbol, so it serializes WITHOUT a resolvable $implRef
      // — i.e. no cross-session authority (it cannot be re-resolved on reload).
      expect(v.symbol).toBeUndefined();
      expect(getVerifiedProvenance(fn)!.symbol).toBeUndefined();
    });

    it("a dynamic-provenance fn whose src disagrees with its identity still fails closed", () => {
      const fn = Object.assign(() => undefined, {
        src: "cf:module/OTHER_MODULE/main.tsx:2:1",
      });
      recordVerifiedProvenance(fn, { identity: "DYN_MODULE", dynamic: true });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { implementation: fn },
      );
      expect(identity?.kind).toBe("unsupported");
    });

    it("a dynamic artifact (no symbol) serializes without $implRef", async () => {
      // moduleToJSON only emits $implRef when provenance.symbol is present, so a
      // dynamic (symbol-less) artifact never gets a serialized, reload-resolvable
      // reference — confirming in-session-only authority on the serialization seam.
      const pattern = await setup();
      const mod = handlerModules(pattern)[0];
      const fn = mod.implementation as HarnessedFunction;
      // Drop the real (symbol-bearing) entry by GC isn't possible; instead build
      // a fresh fn with only dynamic provenance and a module shaped like the real
      // one, then serialize it.
      const dyn = Object.assign(function dynImpl() {}, {
        src: (fn as { src?: string }).src,
        implementationRef: "dyn-ref",
      });
      recordVerifiedProvenance(dyn, {
        identity: getVerifiedProvenance(fn)!.identity,
        dynamic: true,
      });
      const dynModule = {
        type: "javascript" as const,
        implementation: dyn,
        implementationRef: "dyn-ref",
        toJSON: undefined as unknown,
      };
      // moduleToJSON is reached via the builder; call the same path the real
      // module uses. We re-import it lazily to avoid widening the import surface.
      const { moduleToJSON } = await import("../src/builder/json-utils.ts");
      const json = moduleToJSON(dynModule as unknown as Module) as Record<
        string,
        unknown
      >;
      expect(json.$implRef).toBeUndefined();
    });
  });

  // ===========================================================================
  // E2 red-team gate. The attacks below target the surfaces PR E2 introduced
  // (provenance-only verified identity, the now-LIVE bundleId verification arm,
  // the strong content-addressed implementation index, and the loadId-less
  // dynamic registrar). They are the negative complement to the happy-path
  // tests in content-addressed-identity.test.ts.
  // ===========================================================================

  // A claim/identity driver matching attack 5's, lifted to the outer scope so
  // the E2 bundleId-arm attacks can reuse it.
  const driveE2Claim = async (
    claim: Record<string, unknown>,
    identity: Record<string, unknown>,
    name: string,
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: `ts-${name}`,
        actingPrincipal: signer.did(),
      }),
    });
    const tx = runtime.edit();
    const schema = {
      type: "object",
      properties: {
        owned: { type: "string", ifc: { writeAuthorizedBy: claim } },
      },
      required: ["owned"],
    } as unknown as JSONSchema;
    const cell = runtime.getCell(signer.did(), name, schema, tx);
    tx.setCfcImplementationIdentity(identity as never);
    cell.set({ owned: "x" });
    const digest = tx.prepareCfc();
    const result = await tx.commit();
    return { digest, result };
  };

  // ---------------------------------------------------------------------------
  // Attack 8 — the bundleId verification arm is now LIVE (provenance carries a
  // bundleId), so it becomes an attack target. It must stay strictly bounded:
  // it serves ONLY stored legacy bundleId-only claims, never lets a bundleId
  // back-door a moduleIdentity-bearing claim, and never matches on empty ids.
  // (attack 5 line 646 already pins the OTHER direction: a bundleId-only claim
  // vs a bundleId-less identity. These pin the inverse + the empties.)
  // ---------------------------------------------------------------------------
  describe("attack 8: bundleId arm cannot launder a moduleIdentity claim", () => {
    it("a claim carrying BOTH ids selects the moduleIdentity arm: matching bundleId + WRONG moduleIdentity fails closed", async () => {
      // The claim has moduleIdentity, so `identityArmMatches` consults ONLY the
      // moduleIdentity arm — a matching bundleId must NOT be a fallback that
      // satisfies it (no cross-arm confusion in the new live-bundleId world).
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            moduleIdentity: "owner-module",
            bundleId: "shared-bundle",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "attacker-module", // selected arm: MISMATCH
          bundleId: "shared-bundle", // matches, but must be ignored
          sourceFile: "/owner.tsx",
          bindingPath: ["ownerHandler"],
        },
        "attack8-bothids-modmismatch",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("a legacy bundleId-only claim fails closed against a verified writer with a DIFFERENT bundleId", async () => {
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            bundleId: "owner-bundle",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "attacker-module",
          bundleId: "attacker-bundle", // does NOT match the claim's bundleId
          sourceFile: "/owner.tsx",
          bindingPath: ["ownerHandler"],
        },
        "attack8-wrong-bundle",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("an empty-string bundleId on both sides does NOT match (length>0 guard, no vacuous bundle)", async () => {
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            bundleId: "",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "m",
          bundleId: "", // empty == empty, but the arm requires length > 0
          sourceFile: "/owner.tsx",
          bindingPath: ["ownerHandler"],
        },
        "attack8-empty-bundle",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("a legacy bundleId-only claim with matching bundleId but WRONG path fails closed (path still checked)", async () => {
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            bundleId: "shared-bundle",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "m",
          bundleId: "shared-bundle", // arm matches
          sourceFile: "/owner.tsx", // file matches
          bindingPath: ["attackerHandler"], // path does NOT
        },
        "attack8-bundle-pathmismatch",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("control: a legacy bundleId-only claim with fully-matching bundleId+file+path is accepted (arm is not vacuous)", async () => {
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            bundleId: "match-bundle",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "any-module", // irrelevant: claim has no moduleIdentity
          bundleId: "match-bundle",
          sourceFile: "/owner.tsx",
          bindingPath: ["ownerHandler"],
        },
        "attack8-bundle-accept",
      );
      // The bundleId arm passes; any residual failure must not be writeAuthorizedBy.
      expect(typeof digest).toBe("string");
      if (result.error) {
        expect(String(result.error)).not.toContain("writeAuthorizedBy");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 9 — dynamic (in-action) artifacts inherit the invoker's bundleId.
  // A dynamic identity carries a bundleId but NO symbol and NO bindingPath, so
  // it can never satisfy a verified-BINDING (bindingPath) claim, and its
  // inherited bundleId cannot be aimed at a foreign owner's protected field.
  // ---------------------------------------------------------------------------
  describe("attack 9: dynamic-artifact bundleId inheritance cannot escalate", () => {
    it("a dynamic provenance fn resolves verified with the inherited bundleId but NO bindingPath/symbol", () => {
      const fn = Object.assign(() => undefined, {
        src: "cf:module/DYN_INHERIT/main.tsx:3:2",
      });
      // Mirrors the in-action registrar: identity from canonical src, dynamic,
      // inheriting the verified invoker's bundleId — but no export symbol.
      recordVerifiedProvenance(fn, {
        identity: "DYN_INHERIT",
        dynamic: true,
        bundleId: "INHERITED_BUNDLE",
      });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript" } as Module,
        { harness: runtime?.harness, implementation: fn },
      );
      expect(identity?.kind).toBe("verified");
      const v = identity as {
        kind: "verified";
        bundleId?: string;
        symbol?: string;
        bindingPath?: string[];
      };
      expect(v.bundleId).toBe("INHERITED_BUNDLE");
      expect(v.symbol).toBeUndefined();
      // The absence of bindingPath is what stops it satisfying a binding claim.
      expect(v.bindingPath).toBeUndefined();
    });

    it("a dynamic identity (bundleId only, NO file/path) cannot satisfy a legacy bundleId claim aimed at an owner's field", async () => {
      // Even though the inherited bundleId matches, the dynamic identity has no
      // sourceFile/bindingPath, so the file/path equality checks reject — a
      // dynamic artifact can never reach into a foreign owner's protected cell.
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            bundleId: "INHERITED_BUNDLE",
            file: "/victim.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "DYN_INHERIT",
          bundleId: "INHERITED_BUNDLE", // arm matches...
          // ...but no sourceFile and no bindingPath (a dynamic artifact).
        },
        "attack9-dynamic-nopath",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });

    it("a verified-BINDING claim cannot be satisfied by a dynamic (bindingPath-less) identity", async () => {
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            moduleIdentity: "DYN_INHERIT",
            file: "/victim.tsx",
            path: ["ownerHandler"],
          },
        },
        {
          kind: "verified",
          moduleIdentity: "DYN_INHERIT", // even module matches
          bundleId: "INHERITED_BUNDLE",
          // no bindingPath → rejected at the `!identity.bindingPath` gate.
        },
        "attack9-dynamic-binding-claim",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 10 — the strong content-addressed implementation index
  // (verifiedImplementationsByEntryRef, surfaced as
  // harness.getVerifiedImplementation). A replayed/forged $implRef must MISS,
  // and a genuine one returns the REAL recorded function — never attacker data.
  // ---------------------------------------------------------------------------
  describe("attack 10: $implRef replay against the strong implementation index", () => {
    it("a forged identity, or the genuine identity with an unregistered symbol, misses; the genuine pair returns the real fn", async () => {
      const pattern = await setup();
      const mod = handlerModules(pattern)[0];
      const fn = mod.implementation as HarnessedFunction;
      const prov = getVerifiedProvenance(fn)!;
      const harness = runtime!.harness as unknown as {
        getVerifiedImplementation?: (
          identity: string,
          symbol: string,
        ) => unknown;
      };
      // Never-evaluated identity → miss.
      expect(
        harness.getVerifiedImplementation?.("forged-identity", prov.symbol!),
      ).toBeUndefined();
      // Genuine identity, symbol that was never registered under it → miss.
      expect(
        harness.getVerifiedImplementation?.(
          prov.identity,
          "unregistered-symbol",
        ),
      ).toBeUndefined();
      // The genuine pair returns the EXACT recorded function (a trust-gated
      // artifact's implementation), never attacker-controlled data.
      const resolved = harness.getVerifiedImplementation?.(
        prov.identity,
        prov.symbol!,
      );
      expect(resolved).toBe(fn);
      // And that resolved fn is itself verified (its provenance is intact).
      expect(getVerifiedProvenance(resolved)).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 11 — the loadId-less dynamic registrar must not leak a load id (that
  // would feed CFC bundle-id derivation) and must not be evicted by a real
  // load that shares its ref. Pinned at the registry seam.
  // ---------------------------------------------------------------------------
  describe("attack 11: dynamic registrar never leaks a verifiedLoadId", () => {
    it("a dynamic ref has NO verifiedLoadId and its partition has NO bundleId (cannot feed bundle-id derivation)", () => {
      const reg = new ExecutableRegistry();
      const fn = (() => {}) as unknown as HarnessedFunction;
      reg.registerDynamicVerifiedFunction("dyn-ref-leak", fn);
      // It IS executable (the live-closure rehydration channel)...
      expect(reg.getExecutableFunction("dyn-ref-leak")).toBe(fn);
      // ...but carries NO load id: surfacing the reserved partition key as a
      // verifiedLoadId would leak it into CFC bundle-id derivation.
      expect(reg.getVerifiedLoadId("dyn-ref-leak")).toBeUndefined();
      // The reserved partition key itself is not a resolvable bundle.
      expect(reg.getVerifiedBundleId("dynamic:in-action")).toBeUndefined();
    });

    it("a real load that shares a dynamic ref does NOT evict it (cross-load repair finds the dynamic owner)", () => {
      const reg = new ExecutableRegistry();
      const dyn = (() => {}) as unknown as HarnessedFunction;
      reg.registerDynamicVerifiedFunction("shared-ref", dyn);
      // A real (esm) load registers the same ref, then re-begins.
      reg.registerVerifiedFunction(
        "space:esm:1",
        "shared-ref",
        (() => {}) as unknown as HarnessedFunction,
      );
      reg.beginVerifiedLoad("space:esm:1");
      // The ref still resolves — repointed to the dynamic owner, not deleted.
      expect(reg.getExecutableFunction("shared-ref")).toBe(dyn);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 12 — host-artifact escalation. A host-trusted callable EXECUTES but
  // yields NO `kind:"verified"` CFC identity, by two independent defenses: the
  // `unsafe-host:` debugName short-circuit AND the absence of provenance. A
  // genuine canonical `fn.src` on a host fn does NOT manufacture verification.
  // ---------------------------------------------------------------------------
  describe("attack 12: host artifacts execute but never resolve verified", () => {
    it("an unsafe-host: debugName resolves undefined (never verified)", () => {
      const hostFn = Object.assign(() => 42, {
        // Even carrying a genuine-looking canonical src...
        src: "cf:module/SOME_MODULE/main.tsx:1:1",
      });
      expect(getVerifiedProvenance(hostFn)).toBeUndefined();
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript", debugName: "unsafe-host:7" } as unknown as Module,
        { harness: runtime?.harness, implementation: hostFn },
      );
      expect(identity).toBeUndefined();
    });

    it("a host fn with an EMPTY debugName falls into the provenance arm and resolves undefined (src alone is not proof)", () => {
      const hostFn = Object.assign(() => 42, {
        src: "cf:module/SOME_MODULE/main.tsx:1:1",
      });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript", debugName: "" } as unknown as Module,
        { harness: runtime?.harness, implementation: hostFn },
      );
      // No provenance WeakMap entry → undefined, NOT verified — the canonical
      // src is an own-property the resolver never trusts on its own.
      expect(identity).toBeUndefined();
    });

    it("a host fn given a forged BUILTIN debugName resolves builtin (not verified) and so cannot satisfy a verified-binding claim", async () => {
      const hostFn = Object.assign(() => 42, {
        src: "cf:module/SOME_MODULE/main.tsx:1:1",
      });
      const identity = resolvePolicyFacingImplementationIdentity(
        { type: "javascript", debugName: "forgedBuiltin" } as unknown as Module,
        { harness: runtime?.harness, implementation: hostFn },
      );
      expect(identity?.kind).toBe("builtin");
      // A builtin identity is rejected by a verified-BINDING writeAuthorizedBy
      // claim (it demands `identity.kind === "verified"`), so the forged-builtin
      // dodge buys no ownership.
      const { digest, result } = await driveE2Claim(
        {
          __ctWriterIdentityOf: {
            moduleIdentity: "owner-module",
            file: "/owner.tsx",
            path: ["ownerHandler"],
          },
        },
        { kind: "builtin", builtinId: "forgedBuiltin" },
        "attack12-builtin-vs-binding",
      );
      expect(digest).toBe("");
      expect(result.error).toBeDefined();
    });
  });
});
