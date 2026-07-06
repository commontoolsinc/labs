import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildCfcTrustConfig,
  type CfcTrustConfigInput,
  createTrustResolver,
  MAX_TRUST_CLOSURE_DEPTH,
} from "../src/cfc/trust.ts";

const signer = await Identity.fromPassphrase("runner-cfc-trust");

// Epic B3 (docs/plans/cfc-future-work-implementation.md §3): the user-scoped
// trust closure (spec §4.8.9). Concept guards resolve from CONCRETE carried
// integrity via the acting principal's delegations; concrete integrity stays
// portable across users while concept satisfaction is acting-principal
// scoped (invariant 11).

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const AUDITOR = "did:key:auditor-firm";
const OTHER_AUDITOR = "did:key:other-firm";
const AGE_ROUNDING = "https://commonfabric.org/cfc/concepts/age-rounding";
const LOCATION_ROUNDING =
  "https://commonfabric.org/cfc/concepts/location-rounding";
const PRIVACY_PRESERVING =
  "https://commonfabric.org/cfc/concepts/privacy-preserving";

const roundingCodeAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: "sha256:rounding-v1",
};
const unrelatedAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: "sha256:other",
};

const config = (overrides: Partial<CfcTrustConfigInput> = {}) =>
  buildCfcTrustConfig({
    statements: [{
      concrete: roundingCodeAtom,
      implements: AGE_ROUNDING,
      verifier: AUDITOR,
    }],
    delegations: [{
      delegator: ALICE,
      verifier: AUDITOR,
      concepts: [AGE_ROUNDING],
    }],
    ...overrides,
  })!;

describe("CFC trust closure (B3)", () => {
  describe("conceptSatisfied", () => {
    it("satisfies a concept via a delegated statement and a matching atom", () => {
      const resolver = createTrustResolver(config());
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], ALICE))
        .toBe(true);
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [unrelatedAtom], ALICE))
        .toBe(false);
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [], ALICE)).toBe(false);
    });

    it("scopes concept satisfaction to the acting principal (inv-11)", () => {
      const resolver = createTrustResolver(config());
      // The SAME concrete atom is portable, but Bob never delegated to the
      // auditor, so HIS closure does not admit the concept.
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], ALICE))
        .toBe(true);
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], BOB))
        .toBe(false);
      expect(
        resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], undefined),
      ).toBe(false);
    });

    it("supports deployment-root ('*') delegations and concept wildcards", () => {
      const resolver = createTrustResolver(config({
        delegations: [{ delegator: "*", verifier: AUDITOR, concepts: "*" }],
      }));
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], BOB))
        .toBe(true);
      expect(
        resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], undefined),
      ).toBe(true);
    });

    it("ignores statements from verifiers delegated for OTHER concepts only", () => {
      const resolver = createTrustResolver(config({
        delegations: [{
          delegator: ALICE,
          verifier: AUDITOR,
          concepts: [LOCATION_ROUNDING],
        }],
      }));
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], ALICE))
        .toBe(false);
    });

    it("ignores statements from undelegated verifiers", () => {
      const resolver = createTrustResolver(config({
        statements: [{
          concrete: roundingCodeAtom,
          implements: AGE_ROUNDING,
          verifier: OTHER_AUDITOR,
        }],
      }));
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], ALICE))
        .toBe(false);
    });

    it("matches the statement's concrete side as an atom PATTERN", () => {
      const resolver = createTrustResolver(config({
        statements: [{
          // Family-level statement: any TransformedBy naming this codeHash.
          concrete: {
            type: CFC_ATOM_TYPE.TransformedBy,
            codeHash: "sha256:rounding-v1",
          },
          implements: AGE_ROUNDING,
          verifier: AUDITOR,
        }],
      }));
      const carried = {
        type: CFC_ATOM_TYPE.TransformedBy,
        codeHash: "sha256:rounding-v1",
        operation: "map",
        inputs: [],
      };
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [carried], ALICE))
        .toBe(true);
      expect(
        resolver.conceptSatisfied(AGE_ROUNDING, [{
          ...carried,
          codeHash: "sha256:evil",
        }], ALICE),
      ).toBe(false);
    });

    it("closes transitively over concept edges", () => {
      const resolver = createTrustResolver(config({
        delegations: [{
          delegator: ALICE,
          verifier: AUDITOR,
          concepts: [AGE_ROUNDING],
        }],
        conceptEdges: [
          { from: AGE_ROUNDING, to: LOCATION_ROUNDING },
          { from: LOCATION_ROUNDING, to: PRIVACY_PRESERVING },
        ],
      }));
      expect(
        resolver.conceptSatisfied(
          PRIVACY_PRESERVING,
          [roundingCodeAtom],
          ALICE,
        ),
      ).toBe(true);
      // Edges are directed: nothing implements LOCATION_ROUNDING directly,
      // so the reverse query fails.
      expect(
        resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], BOB),
      ).toBe(false);
    });

    it("is cycle-safe and fails closed past the depth bound", () => {
      const cycleResolver = createTrustResolver(config({
        conceptEdges: [
          { from: AGE_ROUNDING, to: LOCATION_ROUNDING },
          { from: LOCATION_ROUNDING, to: AGE_ROUNDING },
        ],
      }));
      // Terminates and answers correctly despite the cycle.
      expect(
        cycleResolver.conceptSatisfied(
          LOCATION_ROUNDING,
          [roundingCodeAtom],
          ALICE,
        ),
      ).toBe(true);
      expect(
        cycleResolver.conceptSatisfied(
          PRIVACY_PRESERVING,
          [roundingCodeAtom],
          ALICE,
        ),
      ).toBe(false);

      // A chain within the bound resolves; one hop past it fails closed.
      const chain = (length: number) =>
        Array.from({ length }, (_, i) => ({
          from: i === 0 ? AGE_ROUNDING : `concept:${i}`,
          to: `concept:${i + 1}`,
        }));
      const within = createTrustResolver(config({
        conceptEdges: chain(MAX_TRUST_CLOSURE_DEPTH),
      }));
      expect(
        within.conceptSatisfied(
          `concept:${MAX_TRUST_CLOSURE_DEPTH}`,
          [roundingCodeAtom],
          ALICE,
        ),
      ).toBe(true);
      const past = createTrustResolver(config({
        conceptEdges: chain(MAX_TRUST_CLOSURE_DEPTH + 1),
      }));
      expect(
        past.conceptSatisfied(
          `concept:${MAX_TRUST_CLOSURE_DEPTH + 1}`,
          [roundingCodeAtom],
          ALICE,
        ),
      ).toBe(false);
    });

    it("fails closed with no config", () => {
      const resolver = createTrustResolver(undefined);
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [roundingCodeAtom], ALICE))
        .toBe(false);
    });

    it("dedups multiple statements implementing the same concept", () => {
      // Two admissible statements bind different concrete principals to the
      // SAME concept (spec §4.8.5 multiple declassification paths); either
      // matching atom satisfies it, and an already-reached concept is not
      // re-derived.
      const resolver = createTrustResolver(config({
        statements: [
          {
            concrete: roundingCodeAtom,
            implements: AGE_ROUNDING,
            verifier: AUDITOR,
          },
          {
            concrete: unrelatedAtom,
            implements: AGE_ROUNDING,
            verifier: AUDITOR,
          },
        ],
      }));
      expect(
        resolver.conceptSatisfied(
          AGE_ROUNDING,
          [roundingCodeAtom, unrelatedAtom],
          ALICE,
        ),
      ).toBe(true);
      expect(resolver.conceptSatisfied(AGE_ROUNDING, [unrelatedAtom], ALICE))
        .toBe(true);
    });
  });

  describe("buildCfcTrustConfig", () => {
    it("returns undefined for undefined input", () => {
      expect(buildCfcTrustConfig(undefined)).toBeUndefined();
    });

    it("digests content and deep-freezes", () => {
      const a = config();
      const b = config();
      expect(a.digest).toBe(b.digest);
      const different = config({
        conceptEdges: [{ from: AGE_ROUNDING, to: PRIVACY_PRESERVING }],
      });
      expect(different.digest).not.toBe(a.digest);
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.statements)).toBe(true);
      expect(Object.isFrozen(a.statements[0])).toBe(true);
      expect(Object.isFrozen(a.statements[0].concrete)).toBe(true);
    });

    it("fails closed on malformed config", () => {
      expect(() => buildCfcTrustConfig({ typo: [] } as unknown as never))
        .toThrow(/unknown key "typo"/);
      expect(() =>
        buildCfcTrustConfig({
          statements: [{ implements: AGE_ROUNDING, verifier: AUDITOR }],
        } as unknown as never)
      ).toThrow(/needs a concrete atom pattern/);
      expect(() =>
        buildCfcTrustConfig({
          statements: [{
            concrete: roundingCodeAtom,
            implements: "",
            verifier: AUDITOR,
          }],
        })
      ).toThrow(/statement\.implements/);
      expect(() =>
        buildCfcTrustConfig({
          delegations: [{
            delegator: ALICE,
            verifier: AUDITOR,
            concepts: [""],
          }],
        })
      ).toThrow(/delegation\.concepts entry/);
      expect(() =>
        buildCfcTrustConfig({
          delegations: [{
            delegator: ALICE,
            verifier: AUDITOR,
            concepts: "all",
          }],
        } as unknown as never)
      ).toThrow(/delegation\.concepts must be an array/);
      expect(() =>
        buildCfcTrustConfig({
          conceptEdges: [{ from: AGE_ROUNDING }],
        } as unknown as never)
      ).toThrow(/concept edge to/);
      expect(() => buildCfcTrustConfig({ statements: {} } as unknown as never))
        .toThrow(/statements must be an array/);
      expect(() =>
        buildCfcTrustConfig({ statements: ["nope"] } as unknown as never)
      ).toThrow(/statement must be an object/);
      expect(() =>
        buildCfcTrustConfig({
          delegations: [{
            delegator: "",
            verifier: AUDITOR,
            concepts: "*",
          }],
        })
      ).toThrow(/delegation\.delegator/);
      expect(() => buildCfcTrustConfig("nope" as unknown as never))
        .toThrow(/config must be an object/);
    });
  });

  describe("Runtime wiring", () => {
    it("freezes the config, injects it per tx, and covers it in the trust revision", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const trustInput: CfcTrustConfigInput = {
        statements: [{
          concrete: roundingCodeAtom,
          implements: AGE_ROUNDING,
          verifier: AUDITOR,
        }],
        delegations: [{ delegator: "*", verifier: AUDITOR, concepts: "*" }],
      };
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcTrustConfig: trustInput,
      });
      try {
        expect(runtime.cfcTrustConfig).toBeDefined();
        expect(Object.isFrozen(runtime.cfcTrustConfig)).toBe(true);
        const tx = runtime.edit();
        expect(tx.getCfcState().trustConfig).toBe(runtime.cfcTrustConfig);
        // Default provider revision covers the config digest, so a config
        // change reads as a trust-snapshot change to the prepared digest.
        expect(tx.getCfcState().trustSnapshot?.revision)
          .toContain(runtime.cfcTrustConfig!.digest);
        // Write-once: no mid-tx swap.
        (tx as unknown as {
          setCfcTrustConfig: (c: unknown) => void;
        }).setCfcTrustConfig({
          statements: [],
          delegations: [],
          conceptEdges: [],
          digest: "swapped",
        });
        expect(tx.getCfcState().trustConfig).toBe(runtime.cfcTrustConfig);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("leaves trust unset (and revision unsuffixed) when not configured", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        expect(runtime.cfcTrustConfig).toBeUndefined();
        const tx = runtime.edit();
        expect(tx.getCfcState().trustConfig).toBeUndefined();
        expect(tx.getCfcState().trustSnapshot?.revision).toBe(runtime.id);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
