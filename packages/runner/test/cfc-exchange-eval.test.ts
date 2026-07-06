import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  DEFAULT_EXCHANGE_FUEL,
  evaluateExchangeRules,
} from "../src/cfc/exchange-eval.ts";
import {
  buildCfcPolicySnapshot,
  type CfcPolicyRecordInput,
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import { buildCfcTrustConfig, createTrustResolver } from "../src/cfc/trust.ts";
import {
  clauseAlternatives,
  clausesEqual,
  normalizeClause,
} from "../src/cfc/clause.ts";
import type { IFCLabel } from "../src/cfc/label-view-core.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";

// Epic B4 (docs/plans/cfc-future-work-implementation.md §3): the guarded
// rewrite + fuelled fixpoint (spec §4.4.5). Property tests (i)-(vi) from the
// plan, plus the worked examples the calculus exists for.

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const userAlice = cfcAtom.user(ALICE);
const userBob = cfcAtom.user(BOB);
const userOwner = cfcAtom.user("did:key:owner");
const spaceX = cfcAtom.space("space:x");
const spaceY = cfcAtom.space("space:y");
const roleAliceX = cfcAtom.hasRole(ALICE, "space:x", "reader");
const roleAliceY = cfcAtom.hasRole(ALICE, "space:y", "reader");
const roleBobX = cfcAtom.hasRole(BOB, "space:x", "reader");

const spaceReaderRule: ExchangeRule = {
  id: "space-reader-access",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
};

const dropExpiresRule: ExchangeRule = {
  id: "drop-expires",
  appliesTo: { type: CFC_ATOM_TYPE.Expires, timestamp: { var: "$t" } },
  preCondition: {
    integrity: [{ type: "https://example.com/atoms/DetectedBy" }],
  },
  post: { dropClause: true },
};

const snapshot = (
  rules: readonly ExchangeRule[],
  id = "test-policy",
) => buildCfcPolicySnapshot([{ id, rules }])!;

const clauseSetsEqual = (
  a: readonly unknown[],
  b: readonly unknown[],
): boolean =>
  a.length === b.length &&
  a.every((clause) => b.some((other) => clausesEqual(clause, other))) &&
  b.every((clause) => a.some((other) => clausesEqual(clause, other)));

describe("CFC exchange-rule evaluation (B4)", () => {
  describe("guarded rewrite", () => {
    it("adds the instantiated alternative to the matched clause (§4.3.3 example)", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX, userOwner], integrity: [roleAliceX] },
        snapshot([spaceReaderRule]),
      );
      expect(result.exhausted).toBe(false);
      expect(result.firings).toEqual([{
        recordId: "test-policy",
        ruleId: "space-reader-access",
        clauseIndex: 0,
        kind: "add",
        added: [userAlice],
      }]);
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [spaceX, userAlice] },
        userOwner,
      ])).toBe(true);
    });

    it("never fires with an unsatisfied integrity guard (property v, inv-3)", () => {
      const noEvidence = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [] },
        snapshot([spaceReaderRule]),
      );
      expect(noEvidence.firings).toEqual([]);
      expect(noEvidence.label.confidentiality).toEqual([spaceX]);

      // Wrong-space evidence: the shared $s variable cannot unify.
      const wrongSpace = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [roleAliceY] },
        snapshot([spaceReaderRule]),
      );
      expect(wrongSpace.firings).toEqual([]);
    });

    it("takes guard evidence from ctx.integrity as well as the label", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([spaceReaderRule]),
        { integrity: [roleAliceX] },
      );
      expect(result.firings.length).toBe(1);
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [spaceX, userAlice] },
      ])).toBe(true);
    });

    it("yields the disjunction of ALL bindings (§4.3.4 multiple matches)", () => {
      // Two role facts for the SAME space: both principals become
      // alternatives of the one matched clause.
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [roleAliceX, roleBobX] },
        snapshot([spaceReaderRule]),
      );
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [spaceX, userAlice, userBob] },
      ])).toBe(true);

      // Two spaces with per-space roles: each clause gains ITS OWN space's
      // reader (the $s correlation), never the other's.
      const correlated = evaluateExchangeRules(
        {
          confidentiality: [spaceX, spaceY],
          integrity: [roleAliceX, roleAliceY],
        },
        snapshot([spaceReaderRule]),
      );
      expect(clauseSetsEqual(correlated.label.confidentiality!, [
        { anyOf: [spaceX, userAlice] },
        { anyOf: [spaceY, userAlice] },
      ])).toBe(true);
    });

    it("drops the matched alternative; the clause goes when it was the last (§4.2.3)", () => {
      const detected = { type: "https://example.com/atoms/DetectedBy" };
      // Singleton Expires clause: the whole clause is discharged.
      const singleton = evaluateExchangeRules(
        {
          confidentiality: [cfcAtom.expires(1000), userOwner],
          integrity: [detected],
        },
        snapshot([dropExpiresRule]),
      );
      expect(singleton.firings).toEqual([{
        recordId: "test-policy",
        ruleId: "drop-expires",
        clauseIndex: 0,
        kind: "drop",
        dropped: cfcAtom.expires(1000),
      }]);
      expect(singleton.label.confidentiality).toEqual([userOwner]);

      // Inside a wider clause only the alternative goes (a TIGHTENING —
      // fewer ways to satisfy the clause).
      const inner = evaluateExchangeRules(
        {
          confidentiality: [{ anyOf: [cfcAtom.expires(1000), userOwner] }],
          integrity: [detected],
        },
        snapshot([dropExpiresRule]),
      );
      expect(inner.label.confidentiality).toEqual([userOwner]);
    });

    it("chains firings to a fixpoint across rules", () => {
      const tierA = { type: "https://example.com/atoms/Tier", level: "a" };
      const tierB = { type: "https://example.com/atoms/Tier", level: "b" };
      const tierC = { type: "https://example.com/atoms/Tier", level: "c" };
      const upgrade = (
        id: string,
        from: unknown,
        to: unknown,
      ): ExchangeRule => ({
        id,
        appliesTo: from,
        post: { addAlternatives: [to] },
      });
      const result = evaluateExchangeRules(
        { confidentiality: [tierA] },
        snapshot([
          upgrade("a-to-b", tierA, tierB),
          upgrade("b-to-c", tierB, tierC),
        ]),
      );
      // b-to-c sorts before a-to-b but cannot fire until a-to-b has added
      // tierB — the fixpoint picks it up on the next pass.
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [tierA, tierB, tierC] },
      ])).toBe(true);
      expect(result.firings.map((firing) => firing.ruleId))
        .toEqual(["a-to-b", "b-to-c"]);
    });

    it("scopes confidentiality side conditions to the target clause by default", () => {
      const marker = { type: "https://example.com/atoms/Marker" };
      const rule: ExchangeRule = {
        id: "needs-marker",
        appliesTo: spaceX,
        preCondition: { confidentiality: [marker] },
        post: { addAlternatives: [userAlice] },
      };
      // Marker sits in a SIBLING clause: targetClause scope must not see it.
      const scoped = evaluateExchangeRules(
        { confidentiality: [spaceX, marker] },
        snapshot([rule]),
      );
      expect(scoped.firings).toEqual([]);
      // Same label under anywhere scope fires.
      const anywhere = evaluateExchangeRules(
        { confidentiality: [spaceX, marker] },
        snapshot([{ ...rule, preConfScope: "anywhere" }]),
      );
      expect(anywhere.firings.length).toBe(1);
      // And targetClause scope fires when the marker shares the clause.
      const sameClause = evaluateExchangeRules(
        { confidentiality: [{ anyOf: [spaceX, marker] }] },
        snapshot([rule]),
      );
      expect(sameClause.firings.length).toBe(1);
    });

    it("gates on boundary-context atoms from the evaluation site", () => {
      const rule: ExchangeRule = {
        id: "display-only",
        appliesTo: spaceX,
        preCondition: {
          boundary: [{
            type: CFC_ATOM_TYPE.BoundaryContext,
            key: "sinkClass",
            value: "display",
          }],
        },
        post: { addAlternatives: [userAlice] },
      };
      const atDisplay = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([rule]),
        { boundary: [cfcAtom.boundaryContext("sinkClass", "display")] },
      );
      expect(atDisplay.firings.length).toBe(1);
      const atNetwork = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([rule]),
        { boundary: [cfcAtom.boundaryContext("sinkClass", "network")] },
      );
      expect(atNetwork.firings).toEqual([]);
      const noContext = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([rule]),
      );
      expect(noContext.firings).toEqual([]);
    });

    it("resolves concept guards through the trust closure only", () => {
      const concept = "https://commonfabric.org/cfc/concepts/screened";
      const detectorAtom = {
        type: "https://commonfabric.org/cfc/atom/CodeHash",
        hash: "sha256:detector",
      };
      const rule: ExchangeRule = {
        id: "concept-guarded",
        appliesTo: spaceX,
        preCondition: { integrity: [cfcAtom.concept(concept)] },
        post: { addAlternatives: [userAlice] },
      };
      const trust = createTrustResolver(buildCfcTrustConfig({
        statements: [{
          concrete: detectorAtom,
          implements: concept,
          verifier: "did:key:auditor",
        }],
        delegations: [{
          delegator: ALICE,
          verifier: "did:key:auditor",
          concepts: "*",
        }],
      }));

      const satisfied = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [detectorAtom] },
        snapshot([rule]),
        { trustResolver: trust, actingPrincipal: ALICE },
      );
      expect(satisfied.firings.length).toBe(1);

      // Same atoms, different acting principal (inv-11 scoping).
      const otherUser = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [detectorAtom] },
        snapshot([rule]),
        { trustResolver: trust, actingPrincipal: BOB },
      );
      expect(otherUser.firings).toEqual([]);

      // No resolver at all: concept guards fail closed.
      const noResolver = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [detectorAtom] },
        snapshot([rule]),
      );
      expect(noResolver.firings).toEqual([]);

      // A LITERAL Concept atom in carried integrity is not evidence: the
      // guard routes through the closure, never the pool.
      const forged = evaluateExchangeRules(
        {
          confidentiality: [spaceX],
          integrity: [cfcAtom.concept(concept)],
        },
        snapshot([rule]),
        { trustResolver: trust, actingPrincipal: BOB },
      );
      expect(forged.firings).toEqual([]);
    });

    it("fails closed on postconditions that cannot instantiate", () => {
      const unbound: ExchangeRule = {
        id: "unbound-post",
        appliesTo: spaceX,
        post: {
          addAlternatives: [{
            type: CFC_ATOM_TYPE.User,
            subject: { var: "$never-bound" },
          }],
        },
      };
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([unbound]),
      );
      expect(result.firings).toEqual([]);
      expect(result.label.confidentiality).toEqual([spaceX]);

      // A postcondition instantiating to a clause-shaped value must not be
      // promoted into clause position.
      const smuggled: ExchangeRule = {
        id: "smuggled-anyof",
        appliesTo: spaceX,
        post: { addAlternatives: [{ anyOf: [userAlice, userBob] }] },
      };
      const smuggledResult = evaluateExchangeRules(
        { confidentiality: [spaceX] },
        snapshot([smuggled]),
      );
      expect(smuggledResult.firings).toEqual([]);
      expect(smuggledResult.label.confidentiality).toEqual([spaceX]);
    });

    it("no-ops drop matches whose target was consumed earlier in the batch", () => {
      // Two integrity bindings produce two matches for the SAME alternative
      // (spec §4.4.5 index discipline: the second application must no-op,
      // not double-drop).
      const detectedA = {
        type: "https://example.com/atoms/DetectedBy",
        id: "a",
      };
      const detectedB = {
        type: "https://example.com/atoms/DetectedBy",
        id: "b",
      };
      const dropWithVarGuard: ExchangeRule = {
        id: "drop-expires-var-guard",
        appliesTo: { type: CFC_ATOM_TYPE.Expires, timestamp: { var: "$t" } },
        preCondition: {
          integrity: [{
            type: "https://example.com/atoms/DetectedBy",
            id: { var: "$d" },
          }],
        },
        post: { dropClause: true },
      };
      // Multi-alternative clause: the second binding's match finds the
      // alternative already gone and no-ops.
      const widened = evaluateExchangeRules(
        {
          confidentiality: [{ anyOf: [cfcAtom.expires(1000), userOwner] }],
          integrity: [detectedA, detectedB],
        },
        snapshot([dropWithVarGuard]),
      );
      expect(widened.label.confidentiality).toEqual([userOwner]);
      expect(widened.firings.length).toBe(1);

      // Singleton clause: the first binding removes the clause entirely; the
      // second match's index is out of range and no-ops.
      const singleton = evaluateExchangeRules(
        {
          confidentiality: [cfcAtom.expires(1000)],
          integrity: [detectedA, detectedB],
        },
        snapshot([dropWithVarGuard]),
      );
      expect(singleton.label.confidentiality).toEqual([]);
      expect(singleton.firings.length).toBe(1);
      expect(singleton.exhausted).toBe(false);
    });

    it("treats a concept guard with a non-string uri as never satisfied", () => {
      const rule: ExchangeRule = {
        id: "malformed-concept-guard",
        appliesTo: spaceX,
        preCondition: {
          integrity: [{ type: CFC_ATOM_TYPE.Concept, uri: { var: "$u" } }],
        },
        post: { addAlternatives: [userAlice] },
      };
      const trust = createTrustResolver(buildCfcTrustConfig({}));
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [roleAliceX] },
        snapshot([rule]),
        { trustResolver: trust, actingPrincipal: ALICE },
      );
      expect(result.firings).toEqual([]);
    });

    it("is the identity without a snapshot, rules, or confidentiality", () => {
      const label: IFCLabel = { confidentiality: [spaceX] };
      expect(evaluateExchangeRules(label, undefined).label).toBe(label);
      expect(evaluateExchangeRules(label, buildCfcPolicySnapshot([])!).label)
        .toBe(label);
      const empty: IFCLabel = { confidentiality: [], integrity: [roleAliceX] };
      expect(
        evaluateExchangeRules(empty, snapshot([spaceReaderRule])).label,
      ).toBe(empty);
    });
  });

  describe("properties", () => {
    it("(i) add-only output clauses are input clauses with superset alternatives; integrity untouched", () => {
      const label: IFCLabel = {
        confidentiality: [spaceX, spaceY, userOwner],
        integrity: [roleAliceX, roleBobX],
      };
      const result = evaluateExchangeRules(label, snapshot([spaceReaderRule]));
      const input = label.confidentiality!;
      const output = result.label.confidentiality!;
      // (ii) no clause creation or merging: counts match, index-aligned.
      expect(output.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        const inputAlternatives = clauseAlternatives(input[i]);
        const outputAlternatives = clauseAlternatives(output[i]);
        for (const alternative of inputAlternatives) {
          expect(
            outputAlternatives.some((other) => deepEqual(other, alternative)),
          ).toBe(true);
        }
      }
      // Integrity is never modified by evaluation.
      expect(result.label.integrity).toBe(label.integrity);
    });

    it("(vi) firing on one clause never touches a sibling (inv-11 locality)", () => {
      const result = evaluateExchangeRules(
        {
          confidentiality: [spaceX, spaceY, userOwner],
          integrity: [roleAliceX],
        },
        snapshot([spaceReaderRule]),
      );
      const output = result.label.confidentiality!;
      // Only the Space(X) clause fired; Space(Y) (no matching role) and the
      // owner clause are exactly their input selves.
      expect(clausesEqual(output[0], { anyOf: [spaceX, userAlice] }))
        .toBe(true);
      expect(clausesEqual(output[1], spaceY)).toBe(true);
      expect(clausesEqual(output[2], userOwner)).toBe(true);
    });

    it("(iii) is deterministic across record/rule/clause/alternative orderings", () => {
      const markerRule: ExchangeRule = {
        id: "marker-adds-bob",
        appliesTo: { type: "https://example.com/atoms/Marker" },
        post: { addAlternatives: [userBob] },
      };
      const labelA: IFCLabel = {
        confidentiality: [
          { anyOf: [spaceX, { type: "https://example.com/atoms/Marker" }] },
          spaceY,
        ],
        integrity: [roleAliceX, roleAliceY],
      };
      const labelB: IFCLabel = {
        confidentiality: [
          spaceY,
          { anyOf: [{ type: "https://example.com/atoms/Marker" }, spaceX] },
        ],
        integrity: [roleAliceY, roleAliceX],
      };
      const snapshotA = buildCfcPolicySnapshot([
        { id: "p1", rules: [spaceReaderRule, markerRule] },
      ])!;
      const snapshotB = buildCfcPolicySnapshot([
        { id: "p1", rules: [markerRule, spaceReaderRule] },
      ])!;
      const a = evaluateExchangeRules(labelA, snapshotA);
      const b = evaluateExchangeRules(labelB, snapshotB);
      expect(clauseSetsEqual(
        a.label.confidentiality!,
        b.label.confidentiality!,
      )).toBe(true);
      // Byte-level determinism for identical inputs.
      const again = evaluateExchangeRules(labelA, snapshotA);
      expect(again.label).toEqual(a.label);
      expect(again.firings).toEqual(a.firings);
    });

    it("(iv) fuel exhaustion returns the ORIGINAL label with the exhausted flag", () => {
      // An add/drop ping-pong (spec §4.4.5's canonical cycle): the drop rule
      // removes the marker alternative, the add rule re-adds it.
      const marker = { type: "https://example.com/atoms/Marker" };
      const addMarker: ExchangeRule = {
        id: "add-marker",
        appliesTo: spaceX,
        post: { addAlternatives: [marker] },
      };
      const dropMarker: ExchangeRule = {
        id: "drop-marker",
        appliesTo: marker,
        post: { dropClause: true },
      };
      const label: IFCLabel = { confidentiality: [spaceX] };
      const result = evaluateExchangeRules(
        label,
        snapshot([addMarker, dropMarker]),
      );
      expect(result.exhausted).toBe(true);
      expect(result.label).toBe(label);
      // Diagnostic trace shows the ping-pong consumed the budget.
      expect(result.firings.length).toBe(DEFAULT_EXCHANGE_FUEL);

      // The same cycle under a tiny explicit budget.
      const tiny = evaluateExchangeRules(
        label,
        snapshot([addMarker, dropMarker]),
        {},
        2,
      );
      expect(tiny.exhausted).toBe(true);
      expect(tiny.label).toBe(label);
    });

    it("converges without exhaustion when work fits the budget exactly", () => {
      // One changing firing with fuel 1: converged, not exhausted (the flag
      // means "budget died before convergence", never "budget reached").
      const result = evaluateExchangeRules(
        { confidentiality: [spaceX], integrity: [roleAliceX] },
        snapshot([spaceReaderRule]),
        {},
        1,
      );
      expect(result.exhausted).toBe(false);
      expect(result.firings.length).toBe(1);
    });

    it("randomized add-only sweep holds (i)/(ii)/(iii) across 200 cases", () => {
      // Deterministic PRNG so failures reproduce.
      let seed = 0x2f6e2b1;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(random() * items.length)];
      const atomPool = [
        spaceX,
        spaceY,
        userAlice,
        userBob,
        userOwner,
        { type: "https://example.com/atoms/Marker" },
        { type: "https://example.com/atoms/Tier", level: "a" },
      ];
      const evidencePool = [roleAliceX, roleAliceY, roleBobX];

      for (let round = 0; round < 200; round++) {
        const clauses: unknown[] = [];
        const clauseCount = 1 + Math.floor(random() * 3);
        for (let i = 0; i < clauseCount; i++) {
          const alternativeCount = 1 + Math.floor(random() * 3);
          const alternatives = Array.from(
            { length: alternativeCount },
            () => pick(atomPool),
          );
          clauses.push(
            alternatives.length === 1
              ? alternatives[0]
              : { anyOf: alternatives },
          );
        }
        const rules: ExchangeRule[] = Array.from(
          { length: 1 + Math.floor(random() * 3) },
          (_, i) => ({
            id: `rule-${i}`,
            appliesTo: pick(atomPool),
            ...(random() < 0.5
              ? {
                preCondition: {
                  integrity: [
                    random() < 0.5 ? pick(evidencePool) : {
                      type: CFC_ATOM_TYPE.HasRole,
                      principal: { var: "$p" },
                    },
                  ],
                },
              }
              : {}),
            post: { addAlternatives: [pick(atomPool)] },
          }),
        );
        const label: IFCLabel = {
          confidentiality: clauses,
          integrity: [pick(evidencePool)],
        };
        const testSnapshot = buildCfcPolicySnapshot([
          { id: "random", rules },
        ])!;
        const result = evaluateExchangeRules(label, testSnapshot);
        expect(result.exhausted).toBe(false);
        const output = result.label.confidentiality!;
        // (ii): add-only evaluation preserves clause count and order.
        expect(output.length).toBe(clauses.length);
        // (i): index-aligned superset (against the NORMALIZED input — the
        // evaluator dedups duplicate authored alternatives on ingest, A3).
        for (let i = 0; i < clauses.length; i++) {
          const inputAlternatives = clauseAlternatives(
            normalizeClause(clauses[i]),
          );
          const outputAlternatives = clauseAlternatives(output[i]);
          expect(outputAlternatives.length)
            .toBeGreaterThanOrEqual(inputAlternatives.length);
          for (const alternative of inputAlternatives) {
            expect(
              outputAlternatives.some((other) => deepEqual(other, alternative)),
            ).toBe(true);
          }
        }
        // (iii): clause-permuted input yields the same clause set.
        const permuted = [...clauses].reverse();
        const permutedResult = evaluateExchangeRules(
          { ...label, confidentiality: permuted },
          testSnapshot,
        );
        expect(clauseSetsEqual(
          output,
          permutedResult.label.confidentiality!,
        )).toBe(true);
      }
    });
  });
});
