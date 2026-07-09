import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import type { CfcGrantResolverQuery } from "../src/cfc/exchange-eval.ts";
import {
  buildCfcPolicySnapshot,
  type CfcPolicyRecordInput,
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import {
  CFC_GRANT_ID_PREFIX,
  cfcGrantDocId,
  expandCfcGrantFacts,
  verifyCfcGrantDocument,
} from "../src/cfc/grants.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { preparedDigestFor } from "../src/cfc/canonical.ts";
import type { PreparedDigestInput } from "../src/cfc/types.ts";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { clausesEqual } from "../src/cfc/clause.ts";

const signer = await Identity.fromPassphrase("runner-cfc-grant-records");

// CFC grant records (spec §8.12.7 route 2a; design
// docs/specs/cfc-persisted-declassification.md §2–3): durable, revocable
// release decisions persisted as content-addressed records at a reserved
// namespace, consumed at access time by `policyState`-guarded exchange rules.
// The stored label never changes — the grant is an INPUT to evaluation.

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const CAROL = "did:key:carol";
const MALLORY = "did:key:mallory";
const userAlice = cfcAtom.user(ALICE);
const userBob = cfcAtom.user(BOB);
const userCarol = cfcAtom.user(CAROL);
const userMallory = cfcAtom.user(MALLORY);
const PHOTO_REF = "of:photo42";

// The §13.4.4 consuming-rule shape: the appliesTo target binds the owner from
// the label's own User(...) clause alternative; the policyState guard resolves
// that owner's ShareGrant over a named resource; the postcondition adds the
// grant's audience principal as an alternative to the matched clause.
const shareRule = (
  overrides: Partial<ExchangeRule> = {},
): ExchangeRule => ({
  id: "user-to-user-share",
  appliesTo: { type: CFC_ATOM_TYPE.User, subject: { var: "$owner" } },
  preCondition: {
    policyState: [{
      kind: "ShareGrant",
      owner: { var: "$owner" },
      resource: PHOTO_REF,
      audience: { type: CFC_ATOM_TYPE.User, subject: { var: "$recipient" } },
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.User,
      subject: { var: "$recipient" },
    }],
  },
  ...overrides,
});

const snapshot = (rules: readonly ExchangeRule[]) =>
  buildCfcPolicySnapshot([{ id: "grant-test-policy", rules }])!;

const clauseSetsEqual = (
  a: readonly unknown[],
  b: readonly unknown[],
): boolean =>
  a.length === b.length &&
  a.every((clause) => b.some((other) => clausesEqual(clause, other))) &&
  b.every((clause) => a.some((other) => clausesEqual(clause, other)));

// A verified, live grant FACT pool entry as the runner-side resolver expands
// it: the grant's scalar fields plus ONE audience entry per fact (§4.3.4
// multi-binding enumerates the disjunction of all matches).
const aliceShareFact = (audience: unknown = userBob) => ({
  kind: "ShareGrant",
  space: ALICE,
  owner: ALICE,
  resource: PHOTO_REF,
  audience,
  grantedAt: 1000,
});

describe("CFC grant records (§8.12.7 route 2a)", () => {
  // -------------------------------------------------------------------------
  // Build-order item 1: the `policyState` guard kind.
  // -------------------------------------------------------------------------
  describe("policyState guard validation (boot, fail closed)", () => {
    const withGuard = (policyState: unknown): CfcPolicyRecordInput[] => [{
      id: "p",
      rules: [{
        id: "r",
        appliesTo: { type: CFC_ATOM_TYPE.User, subject: { var: "$o" } },
        preCondition: { policyState } as ExchangeRule["preCondition"],
        post: { addAlternatives: [userBob] },
      }],
    }];

    it("throws on a non-array policyState", () => {
      expect(() => buildCfcPolicySnapshot(withGuard({ kind: "ShareGrant" })))
        .toThrow(/policyState/);
    });

    it("throws on an empty policyState array (a guard that gates nothing)", () => {
      expect(() => buildCfcPolicySnapshot(withGuard([]))).toThrow(
        /policyState/,
      );
    });

    it("throws on an entry without a concrete string kind", () => {
      // Missing kind entirely.
      expect(() => buildCfcPolicySnapshot(withGuard([{ owner: userAlice }])))
        .toThrow(/kind/);
      // Variable kind: the resolver point-queries by kind — a variable kind
      // would require enumeration (§4.9.3 discipline forbids it).
      expect(() =>
        buildCfcPolicySnapshot(
          withGuard([{ kind: { var: "$k" }, owner: userAlice }]),
        )
      ).toThrow(/kind/);
      // Empty-string kind.
      expect(() => buildCfcPolicySnapshot(withGuard([{ kind: "" }]))).toThrow(
        /kind/,
      );
    });

    it("throws on a non-record guard entry", () => {
      expect(() => buildCfcPolicySnapshot(withGuard(["ShareGrant"]))).toThrow(
        /policyState/,
      );
      expect(() => buildCfcPolicySnapshot(withGuard([["ShareGrant"]])))
        .toThrow(/policyState/);
    });

    it("accepts a well-formed guard and folds it into the record digest", () => {
      const guarded = buildCfcPolicySnapshot([{
        id: "p",
        rules: [shareRule()],
      }])!;
      const unguarded = buildCfcPolicySnapshot([{
        id: "p",
        rules: [shareRule({ preCondition: undefined })],
      }])!;
      expect(guarded.records[0].digest).not.toBe(unguarded.records[0].digest);
      // Stable for identical inputs.
      expect(
        buildCfcPolicySnapshot([{ id: "p", rules: [shareRule()] }])!.records[0]
          .digest,
      ).toBe(guarded.records[0].digest);
    });
  });

  describe("policyState guard evaluation (pure evaluator)", () => {
    it("does not fire without a grant resolver in context (fail closed)", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        snapshot([shareRule()]),
        {},
      );
      expect(result.firings).toEqual([]);
      expect(result.label.confidentiality).toEqual([userAlice]);
    });

    it("does not fire when the resolver returns no grants (fail closed)", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        snapshot([shareRule()]),
        { grantResolver: () => [] },
      );
      expect(result.firings).toEqual([]);
      expect(result.label.confidentiality).toEqual([userAlice]);
    });

    it("fires on a resolved grant, binding variables from grant fields", () => {
      const queries: CfcGrantResolverQuery[] = [];
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        snapshot([shareRule()]),
        {
          grantResolver: (query) => {
            queries.push(query);
            return [aliceShareFact()];
          },
        },
      );
      expect(result.exhausted).toBe(false);
      expect(result.firings.length).toBe(1);
      expect(result.firings[0]).toMatchObject({
        ruleId: "user-to-user-share",
        clauseIndex: 0,
        kind: "add",
        added: [userBob],
      });
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [userAlice, userBob] },
      ])).toBe(true);
      // The resolver is invoked with the guard's kind plus the fields that are
      // concrete under the current bindings — the point-query inputs. The
      // `audience` field (free variable, bound FROM the grant) is not queried.
      expect(queries.length).toBeGreaterThan(0);
      expect(queries[0].kind).toBe("ShareGrant");
      expect(queries[0].fields).toEqual({
        owner: ALICE,
        resource: PHOTO_REF,
      });
    });

    it("requires bound-variable unification with grant fields", () => {
      // Grant owned by CAROL cannot discharge a guard whose $owner bound to
      // ALICE from the matched clause alternative.
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        snapshot([shareRule()]),
        { grantResolver: () => [{ ...aliceShareFact(), owner: CAROL }] },
      );
      expect(result.firings).toEqual([]);
      expect(result.label.confidentiality).toEqual([userAlice]);
    });

    it("adds one alternative per audience fact (§4.3.4 disjunction)", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        snapshot([shareRule()]),
        {
          grantResolver: () => [
            aliceShareFact(userBob),
            aliceShareFact(userCarol),
          ],
        },
      );
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [userAlice, userBob, userCarol] },
      ])).toBe(true);
    });

    it("grant on clause k leaves independent clause j untouched (CT-1874 / inv-11)", () => {
      // Both clauses match the appliesTo pattern (each binds its own $owner);
      // the resolver holds a grant for ALICE only. The rewrite must land on
      // Alice's clause alone — a grant discovered from clause k must not widen
      // clause j ≠ k.
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice, userMallory] },
        snapshot([shareRule()]),
        {
          grantResolver: (query) =>
            query.fields.owner === ALICE ? [aliceShareFact()] : [],
        },
      );
      expect(result.firings.length).toBe(1);
      expect(result.firings[0].clauseIndex).toBe(0);
      expect(clauseSetsEqual(result.label.confidentiality!, [
        { anyOf: [userAlice, userBob] },
        userMallory,
      ])).toBe(true);
      // Mallory's clause is byte-identical to the input — never normalized,
      // never merged, never widened.
      expect(result.label.confidentiality![1]).toEqual(userMallory);
    });

    it("a malformed guard pattern never fires (fail closed at evaluation)", () => {
      // Bypass boot validation deliberately: hand-build a snapshot-shaped
      // object whose guard has a variable kind. The evaluator must fail closed
      // on its own — never resolve, never fire.
      const rule = shareRule({
        preCondition: {
          policyState: [{ kind: { var: "$k" }, owner: { var: "$owner" } }],
        },
      });
      const invoked: CfcGrantResolverQuery[] = [];
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice] },
        {
          records: [{ id: "handmade", digest: "d", rules: [rule] }],
          digest: "d",
        },
        {
          grantResolver: (query) => {
            invoked.push(query);
            return [aliceShareFact()];
          },
        },
      );
      expect(invoked).toEqual([]);
      expect(result.firings).toEqual([]);
    });

    it("a throwing resolver fails the guard closed, not the evaluation", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [userAlice, userMallory] },
        snapshot([shareRule()]),
        {
          grantResolver: () => {
            throw new Error("storage exploded");
          },
        },
      );
      expect(result.firings).toEqual([]);
      expect(result.label.confidentiality).toEqual([userAlice, userMallory]);
    });
  });

  // -------------------------------------------------------------------------
  // Build-order item 2: grant records + reserved-path storage discipline.
  // -------------------------------------------------------------------------
  describe("grant document addressing", () => {
    const identity = {
      space: ALICE,
      kind: "ShareGrant",
      owner: ALICE,
      resource: PHOTO_REF,
    };

    it("derives a deterministic id under the reserved namespace", () => {
      const id = cfcGrantDocId(identity);
      expect(id.startsWith(CFC_GRANT_ID_PREFIX)).toBe(true);
      expect(cfcGrantDocId({ ...identity })).toBe(id);
    });

    it("changes with every identity field, and only identity fields", () => {
      const id = cfcGrantDocId(identity);
      expect(cfcGrantDocId({ ...identity, kind: "Other" })).not.toBe(id);
      expect(cfcGrantDocId({ ...identity, owner: BOB, space: BOB })).not.toBe(
        id,
      );
      expect(cfcGrantDocId({ ...identity, resource: "of:other" })).not.toBe(
        id,
      );
    });

    it("verifies a stored document against its address (fail closed)", () => {
      const id = cfcGrantDocId(identity);
      const value = {
        version: 1,
        ...identity,
        audience: [userBob],
        grantedAt: 1000,
      };
      expect(verifyCfcGrantDocument(ALICE, id, value)).toMatchObject({
        kind: "ShareGrant",
        owner: ALICE,
      });
      // Identity-field drift: content stored at an address it does not hash
      // to is a forgery or corruption — never resolved.
      expect(
        verifyCfcGrantDocument(ALICE, id, { ...value, owner: BOB, space: BOB }),
      ).toBeUndefined();
      // Malformed shapes.
      expect(verifyCfcGrantDocument(ALICE, id, undefined)).toBeUndefined();
      expect(verifyCfcGrantDocument(ALICE, id, "grant")).toBeUndefined();
      expect(verifyCfcGrantDocument(ALICE, id, { ...value, audience: "all" }))
        .toBeUndefined();
    });

    it("expands one fact per audience entry", () => {
      const grant = verifyCfcGrantDocument(
        ALICE,
        cfcGrantDocId(identity),
        {
          version: 1,
          ...identity,
          audience: [userBob, userCarol],
          grantedAt: 1000,
        },
      )!;
      const facts = expandCfcGrantFacts(grant);
      expect(facts.length).toBe(2);
      expect(facts[0]).toMatchObject({ audience: userBob, owner: ALICE });
      expect(facts[1]).toMatchObject({ audience: userCarol, owner: ALICE });
    });
  });

  const SECRET_SCHEMA = internSchema(
    {
      type: "object",
      properties: {
        secret: { type: "string", ifc: { confidentiality: ["never-fits"] } },
      },
      required: ["secret"],
    } satisfies JSONSchema,
    true,
  );

  const seedLabeledCell = async (
    runtime: Runtime,
    id: string,
    label: { confidentiality: unknown[]; integrity?: unknown[] },
  ): Promise<void> => {
    const seed = runtime.edit();
    const target = runtime.getCell(signer.did(), id, undefined, seed);
    const targetId = target.getAsNormalizedFullLink().id;
    seed.writeOrThrow({
      space: signer.did(),
      scope: "space",
      id: targetId,
      path: [],
    }, {
      value: { secret: "rosebud" },
      cfc: {
        version: 1,
        schemaHash: SECRET_SCHEMA.taggedHashString,
        labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
      },
    });
    seed.writeOrThrow({
      space: signer.did(),
      scope: "space",
      id: `cid:${SECRET_SCHEMA.taggedHashString}`,
      path: [],
    }, { value: SECRET_SCHEMA.schema });
    expect((await seed.commit()).ok).toBeDefined();
  };

  // The §13.4.4 rule at the network egress boundary: the acting owner's
  // User(...) clause gains the grant's audience as an alternative.
  const sinkShareRule: ExchangeRule = shareRule({
    preCondition: {
      policyState: [{
        kind: "ShareGrant",
        owner: { var: "$owner" },
        resource: PHOTO_REF,
        audience: { type: CFC_ATOM_TYPE.User, subject: { var: "$recipient" } },
      }],
      boundary: [{
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "sinkClass",
        value: "network",
      }],
    },
  });

  const withRuntime = async (
    opts: {
      policyEvaluation?: "off" | "observe" | "enforce";
      enforcement?: "enforce-explicit" | "observe" | "disabled";
      storageManager?: ReturnType<typeof StorageManager.emulate>;
    },
    body: (
      runtime: Runtime,
      storageManager: ReturnType<typeof StorageManager.emulate>,
    ) => void | Promise<void>,
  ): Promise<void> => {
    const storageManager = opts.storageManager ??
      StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: opts.enforcement ?? "enforce-explicit",
      cfcSinkMaxConfidentiality: { fetchJson: [userBob] },
      cfcPolicyRecords: [{ id: "share-policy", rules: [sinkShareRule] }],
      cfcPolicyEvaluation: opts.policyEvaluation ?? "enforce",
    });
    try {
      await body(runtime, storageManager);
    } finally {
      await runtime.dispose();
      if (opts.storageManager === undefined) {
        await storageManager.close();
      }
    }
  };

  const writeGrant = async (
    runtime: Runtime,
    overrides: Record<string, unknown> = {},
  ): Promise<{ space: string; id: string }> => {
    const tx = runtime.edit();
    const written = tx.writeCfcGrant({
      kind: "ShareGrant",
      owner: signer.did(),
      resource: PHOTO_REF,
      audience: [userBob],
      grantedAt: 1000,
      ...overrides,
    });
    const result = await tx.commit();
    expect(result.ok).toBeDefined();
    return written;
  };

  const readThenSink = (
    runtime: Runtime,
    id: string,
    { abort = true }: { abort?: boolean } = {},
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
    expect(cell.key("secret").get()).toBe("rosebud");
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:grant-records-test",
      createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
      "fetchJson-start",
      () => {},
    );
    tx.prepareCfc();
    const state = tx.getCfcState();
    const reasons = state.prepare.status === "invalidated"
      ? [...state.prepare.reasons]
      : [];
    const result = {
      tx,
      reasons,
      diagnostics: [...state.diagnostics],
      prepare: state.prepare,
    };
    if (abort) tx.abort();
    return result;
  };

  describe("sanctioned grant writer (trusted policy-writer path)", () => {
    it("writes a grant document at the derived id, committable in enforce mode", async () => {
      await withRuntime({}, async (runtime) => {
        const written = await writeGrant(runtime);
        expect(written.id.startsWith(CFC_GRANT_ID_PREFIX)).toBe(true);
        expect(written.space).toBe(signer.did());
        // Readable back at the derived address; verifies against it.
        const tx = runtime.edit();
        const value = tx.readOrThrow({
          space: signer.did(),
          id: written.id as URI,
          type: "application/json",
          path: ["value"],
        });
        expect(
          verifyCfcGrantDocument(written.space, written.id, value),
        ).toMatchObject({ owner: signer.did(), audience: [userBob] });
        tx.abort();
      });
    });

    it("refuses a grant whose owner is not the acting principal", async () => {
      // For this PR the writer's release-authority check is owner === the
      // transaction's acting principal (trust snapshot); the fuller §13.4.3
      // intent-evidence chain arrives with intents.
      await withRuntime({}, (runtime) => {
        const tx = runtime.edit();
        expect(() =>
          tx.writeCfcGrant({
            kind: "ShareGrant",
            owner: MALLORY,
            resource: PHOTO_REF,
            audience: [userBob],
          })
        ).toThrow(/acting principal/);
        tx.abort();
      });
    });

    it("refuses audience entries that are not principal-like (§3.1.8)", async () => {
      await withRuntime({}, (runtime) => {
        const tx = runtime.edit();
        const attempt = (audience: unknown[]) => () =>
          tx.writeCfcGrant({
            kind: "ShareGrant",
            owner: signer.did(),
            resource: PHOTO_REF,
            audience,
          });
        // Caveat/Expires alternatives collapse the caveat discipline / invert
        // most-restrictive-wins — the disallowedAuthoredClauseReason posture.
        expect(attempt([cfcAtom.caveat("screened", userAlice)])).toThrow(
          /audience/,
        );
        expect(attempt([cfcAtom.expires(9999999999999)])).toThrow(/audience/);
        // A clause-shaped entry is not an atom.
        expect(attempt([{ anyOf: [userBob, userCarol] }])).toThrow(/audience/);
        // Var-bearing records interact with pattern matching; never storable.
        expect(attempt([{ type: CFC_ATOM_TYPE.User, subject: { var: "$x" } }]))
          .toThrow(/audience/);
        // Empty audience grants nothing — an authoring error.
        expect(attempt([])).toThrow(/audience/);
        tx.abort();
      });
    });

    it("refuses a revocation not attributed to the acting principal", async () => {
      await withRuntime({}, (runtime) => {
        const tx = runtime.edit();
        expect(() =>
          tx.writeCfcGrant({
            kind: "ShareGrant",
            owner: signer.did(),
            resource: PHOTO_REF,
            audience: [userBob],
            revoked: { at: 2000, by: MALLORY },
          })
        ).toThrow(/revoked/);
        tx.abort();
      });
    });
  });

  describe("reserved-namespace write gate (S18-class)", () => {
    it("rejects an unprivileged write to a grant document in enforce mode", async () => {
      await withRuntime({}, async (runtime) => {
        const tx = runtime.edit();
        tx.writeOrThrow({
          space: signer.did(),
          id: `${CFC_GRANT_ID_PREFIX}forged` as URI,
          type: "application/json",
          path: ["value"],
        }, {
          version: 1,
          space: signer.did(),
          kind: "ShareGrant",
          owner: signer.did(),
          resource: PHOTO_REF,
          audience: [userMallory],
          grantedAt: 1000,
        });
        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(String((result.error as Error).message).toLowerCase())
          .toContain("cfc");
      });
    });

    // The mergeable-op path (push/increment/…) cannot bypass the gate: the
    // storage layer refuses a mergeable op on a document this transaction has
    // not already written ("target is not writable"), and that prior write
    // goes through the gated write chokepoint above. recordMergeableOp still
    // calls noteSystemWrite as defense-in-depth should that structural
    // precondition ever loosen.

    it("records a diagnostic and allows the write in observe mode", async () => {
      await withRuntime({ enforcement: "observe" }, async (runtime) => {
        const tx = runtime.edit();
        tx.writeOrThrow({
          space: signer.did(),
          id: `${CFC_GRANT_ID_PREFIX}forged-observe` as URI,
          type: "application/json",
          path: ["value"],
        }, { probe: true });
        const result = await tx.commit();
        expect(result.ok).toBeDefined();
        expect(
          tx.getCfcState().diagnostics.some((note) =>
            note.includes("unprivileged write to protected cfc path") &&
            note.includes(CFC_GRANT_ID_PREFIX)
          ),
        ).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Resolution wired into the egress gate (build-order items 1+3).
  // -------------------------------------------------------------------------
  describe("grant resolution at the sink egress gate", () => {
    it("a live grant releases the owner clause to the audience (enforce)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-live", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-live");
        expect(reasons).toEqual([]);
      });
    });

    it("without a grant the same egress rejects (fail closed)", async () => {
      await withRuntime({}, async (runtime) => {
        await seedLabeledCell(runtime, "grant-absent", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-absent");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("a revoked grant does not fire", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime, {
          revoked: { at: 2000, by: signer.did() },
        });
        await seedLabeledCell(runtime, "grant-revoked", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-revoked");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("an expired grant does not fire", async () => {
      await withRuntime({}, async (runtime) => {
        // grantedAt/expiresAt long in the past relative to the runner clock.
        await writeGrant(runtime, { grantedAt: 1000, expiresAt: 2000 });
        await seedLabeledCell(runtime, "grant-expired", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-expired");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("an unexpired grant with a future expiry fires", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime, {
          grantedAt: 1000,
          expiresAt: Date.now() + 1_000_000_000,
        });
        await seedLabeledCell(runtime, "grant-unexpired", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-unexpired");
        expect(reasons).toEqual([]);
      });
    });

    it("a malformed grant document does not fire (fail closed)", async () => {
      // Seed a forged/corrupt doc at the derived address through a runtime
      // with CFC disabled — the analog of a client that does not run the
      // write gate. Verification-on-read must refuse it: the stored identity
      // fields do not hash to the address they sit at.
      const storageManager = StorageManager.emulate({ as: signer });
      const seeder = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      const id = cfcGrantDocId({
        space: signer.did(),
        kind: "ShareGrant",
        owner: signer.did(),
        resource: PHOTO_REF,
      });
      const seed = seeder.edit();
      seed.writeOrThrow({
        space: signer.did(),
        id: id as URI,
        type: "application/json",
        path: ["value"],
      }, {
        version: 1,
        space: signer.did(),
        kind: "ShareGrant",
        owner: signer.did(),
        // resource swapped: content no longer hashes to the address.
        resource: "of:everything",
        audience: [userBob],
        grantedAt: 1000,
      });
      expect((await seed.commit()).ok).toBeDefined();
      await seeder.dispose();

      await withRuntime({ storageManager }, async (runtime) => {
        await seedLabeledCell(runtime, "grant-malformed", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons } = readThenSink(runtime, "grant-malformed");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
      await storageManager.close();
    });

    it("releases only the owner clause, never a sibling clause (inv-11)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-sibling", {
          confidentiality: [cfcAtom.user(signer.did()), userMallory],
        });
        const { reasons } = readThenSink(runtime, "grant-sibling");
        const offending = reasons.find((reason) =>
          reason.includes("sink-request confidentiality exceeds ceiling")
        );
        expect(offending).toBeDefined();
        expect(offending).toContain(MALLORY);
        expect(offending).not.toContain(signer.did());
      });
    });

    it("observe: decides on the raw label and diagnoses the would-be release", async () => {
      await withRuntime({ policyEvaluation: "observe" }, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-observe", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons, diagnostics } = readThenSink(runtime, "grant-observe");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        expect(
          diagnostics.some((note) =>
            note.includes("policy-evaluation(observe)") &&
            note.includes("from reject to fit")
          ),
        ).toBe(true);
      });
    });

    it("off: grants are not consulted at all", async () => {
      await withRuntime({ policyEvaluation: "off" }, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-off", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { reasons, prepare } = readThenSink(runtime, "grant-off");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        // No consultation happened: nothing recorded.
        expect(
          prepare.status === "invalidated" &&
            (prepare as { input?: PreparedDigestInput }).input
              ?.consultedGrants,
        ).toBeFalsy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Build-order item 3: read non-taint + digest binding.
  // -------------------------------------------------------------------------
  describe("read non-taint (internalVerifierRead discipline)", () => {
    it("grant lookups never enter the consumed read set", async () => {
      await withRuntime({}, async (runtime) => {
        const { id: grantId } = await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-no-taint", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const { prepare } = readThenSink(runtime, "grant-no-taint");
        expect(prepare.status).toBe("prepared");
        if (prepare.status !== "prepared") return;
        // The grant WAS consulted…
        expect(prepare.input.consultedGrants).toBeDefined();
        expect(
          prepare.input.consultedGrants!.some((g) => g.id === grantId),
        ).toBe(true);
        // …but never entered the consumed set (no taint, no PC entry).
        expect(
          prepare.input.consumedReads.some((read) =>
            read.id.startsWith(CFC_GRANT_ID_PREFIX)
          ),
        ).toBe(false);
      });
    });
  });

  describe("digest binding of consulted grants", () => {
    const base: PreparedDigestInput = {
      consumedReads: [],
      attemptedWrites: [],
      writes: [],
      writeAttemptLog: [],
      dereferenceTraces: [],
      triggerReads: [],
      writePolicyInputs: [],
    };
    const grantA = {
      space: ALICE as MemorySpace,
      id: `${CFC_GRANT_ID_PREFIX}aaa`,
      digest: "digest-a",
    };
    const grantB = {
      space: ALICE as MemorySpace,
      id: `${CFC_GRANT_ID_PREFIX}bbb`,
      digest: "digest-b",
    };

    it("folds consulted grants into the prepared digest (policySnapshot discipline)", () => {
      const withA = preparedDigestFor({ ...base, consultedGrants: [grantA] });
      const withMutatedA = preparedDigestFor({
        ...base,
        consultedGrants: [{ ...grantA, digest: "digest-a-changed" }],
      });
      const without = preparedDigestFor(base);
      // A consulted grant changes the digest; its content digest changing
      // between prepare and commit yields a different prepared digest — the
      // cfc-prepared-digest-mismatch rejection path.
      expect(withA).not.toBe(without);
      expect(withA).not.toBe(withMutatedA);
      // Stable for identical inputs.
      expect(preparedDigestFor({ ...base, consultedGrants: [grantA] }))
        .toBe(withA);
    });

    it("canonicalizes order-insensitively (address-sorted)", () => {
      expect(
        preparedDigestFor({ ...base, consultedGrants: [grantA, grantB] }),
      ).toBe(
        preparedDigestFor({ ...base, consultedGrants: [grantB, grantA] }),
      );
    });

    it("treats an empty consulted set as absent", () => {
      expect(preparedDigestFor({ ...base, consultedGrants: [] })).toBe(
        preparedDigestFor(base),
      );
    });

    it("a grant mutated between prepare and commit rejects the commit", async () => {
      // Layered protection: the digest binds the resolution-time grant
      // content into the prepared decision (in-process drift → the
      // cfc-prepared-digest-mismatch recheck above), and the resolver's
      // verifying read additionally VALIDATES the grant document in the
      // storage journal — so a committing (writing) transaction whose
      // consulted grant was externally mutated fails the storage-level
      // claim check. A zero-write transaction skips that claim pass, the
      // same snapshot-consistency posture every labeled read has; a
      // revocation then takes effect on the next evaluation (design §2.2:
      // "rules stop firing on next evaluation").
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "grant-mutated", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        // Read the labeled cell, derive a written output (a WRITING tx),
        // enqueue the gated egress, prepare — but do NOT commit yet.
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "grant-mutated",
          SECRET_SCHEMA.schema,
          tx,
        );
        expect(cell.key("secret").get()).toBe("rosebud");
        tx.writeOrThrow({
          space: signer.did(),
          id: "of:grant-mutated-out" as URI,
          type: "application/json",
          path: ["value"],
        }, { derived: true });
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:grant-records-mutated",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        // Revoke the grant from a second transaction while the first is
        // prepared-but-uncommitted.
        await writeGrant(runtime, { revoked: { at: 2000, by: signer.did() } });
        // The prepared decision consumed the live grant; the commit must not
        // go through over the revoked one.
        const result = await tx.commit();
        expect(result.error).toBeDefined();
      });
    });
  });
});
