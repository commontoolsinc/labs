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
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import {
  CFC_GRANT_ABSENT_DIGEST,
  CFC_GRANT_ID_PREFIX,
  cfcGrantConsumedReceiptId,
  cfcGrantDocId,
  createTxCfcGrantResolver,
  expandCfcGrantFacts,
  flushCfcGrantConsumptionClaims,
  prepareCfcGrantWrite,
  verifyCfcGrantDocument,
} from "../src/cfc/grants.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-single-use-grants");

// Single-use CFC grants (declass build-order item 5;
// docs/specs/cfc-persisted-declassification.md §2.2 "Single-use releases",
// spec §6.5.1-.2 claim semantics): a grant with `singleUse: true` satisfies
// its policyState guard only while its consumption receipt does not exist,
// and the releasing transaction claims the receipt atomically with the
// release via the shipped `experimental.commitPreconditions` exactly-once
// discipline (create-only receipt document, `receipt-exists` permanent
// rejection for the create-only race loser).

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const MALLORY = "did:key:mallory";
const userBob = cfcAtom.user(BOB);
const userMallory = cfcAtom.user(MALLORY);
const PHOTO_REF = "of:photo42";

const identity = {
  space: ALICE,
  kind: "ShareGrant",
  owner: ALICE,
  resource: PHOTO_REF,
};

const baseInput = {
  kind: "ShareGrant",
  owner: ALICE,
  resource: PHOTO_REF,
  audience: [userBob],
  grantedAt: 1000,
};

describe("CFC single-use grants (§2.2 single-use releases)", () => {
  // ---------------------------------------------------------------------------
  // Item 1: the `singleUse` field.
  // ---------------------------------------------------------------------------
  describe("singleUse field (writer validation)", () => {
    it("accepts singleUse: true and stores it in the value", () => {
      const prepared = prepareCfcGrantWrite(
        { ...baseInput, singleUse: true },
        ALICE,
      );
      expect(prepared.value.singleUse).toBe(true);
    });

    it("omits the field for a standing grant (absent, not false)", () => {
      const prepared = prepareCfcGrantWrite(baseInput, ALICE);
      expect("singleUse" in prepared.value).toBe(false);
    });

    it("refuses anything but boolean-true or absent (malformed)", () => {
      // `false` is refused too: "standing" has exactly one spelling (absent),
      // so no consumer can ever treat a present-but-false marker as a third
      // state.
      const attempt = (singleUse: unknown) => () =>
        prepareCfcGrantWrite(
          { ...baseInput, singleUse } as Parameters<
            typeof prepareCfcGrantWrite
          >[0],
          ALICE,
        );
      expect(attempt(false)).toThrow(/singleUse/);
      expect(attempt(1)).toThrow(/singleUse/);
      expect(attempt("yes")).toThrow(/singleUse/);
      expect(attempt(null)).toThrow(/singleUse/);
    });

    it("does not participate in the address (identity = release scope)", () => {
      // Same release scope, same document: converting a standing grant to
      // single-use (or back) is an in-place update of the SAME durable
      // decision, exactly like audience/lifecycle changes.
      const standing = prepareCfcGrantWrite(baseInput, ALICE);
      const single = prepareCfcGrantWrite(
        { ...baseInput, singleUse: true },
        ALICE,
      );
      expect(single.id).toBe(standing.id);
      expect(single.id).toBe(cfcGrantDocId(identity));
    });
  });

  describe("singleUse field (verify-on-read)", () => {
    const id = cfcGrantDocId(identity);
    const value = {
      version: 1,
      ...identity,
      audience: [userBob],
      grantedAt: 1000,
    };

    it("admits singleUse: true and absent", () => {
      expect(verifyCfcGrantDocument(ALICE, id, value)).toBeDefined();
      expect(
        verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: true })
          ?.singleUse,
      ).toBe(true);
    });

    it("rejects a malformed singleUse (defense in depth)", () => {
      expect(verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: false }))
        .toBeUndefined();
      expect(verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: 1 }))
        .toBeUndefined();
      expect(
        verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: "true" }),
      ).toBeUndefined();
    });

    it("carries singleUse through fact expansion (absent stays absent)", () => {
      const single = verifyCfcGrantDocument(ALICE, id, {
        ...value,
        singleUse: true,
      })!;
      expect(expandCfcGrantFacts(single)[0]).toMatchObject({
        singleUse: true,
      });
      const standing = verifyCfcGrantDocument(ALICE, id, value)!;
      const fact = expandCfcGrantFacts(standing)[0] as Record<string, unknown>;
      // Standing facts stay byte-identical to #4627 — no new key.
      expect("singleUse" in fact).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Item 2: the consumption receipt identity.
  // ---------------------------------------------------------------------------
  describe("consumption receipt derivation", () => {
    const grantId = cfcGrantDocId(identity);

    it("derives a deterministic receipt id in the reserved namespace", () => {
      const receipt = cfcGrantConsumedReceiptId(grantId);
      expect(receipt.startsWith(CFC_GRANT_ID_PREFIX)).toBe(true);
      expect(cfcGrantConsumedReceiptId(grantId)).toBe(receipt);
    });

    it("is distinct from the grant id and varies with it", () => {
      const receipt = cfcGrantConsumedReceiptId(grantId);
      expect(receipt).not.toBe(grantId);
      const other = cfcGrantDocId({ ...identity, resource: "of:other" });
      expect(cfcGrantConsumedReceiptId(other)).not.toBe(receipt);
    });
  });
});
