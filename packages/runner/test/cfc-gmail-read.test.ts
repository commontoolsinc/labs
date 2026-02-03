/**
 * CFC Gmail Read Path — end-to-end integration test
 *
 * Models the Gmail read flow from the CFC spec (01-gmail-example.md):
 *
 *   1. OAuth token cell has ifc: { classification: ["secret"] } on token field
 *   2. Recipe reads token to build Authorization header
 *   3. fetchData calls Gmail API (mocked) with the token
 *   4. Response arrives and is written to result cell
 *   5. Recipe processes response into an output cell
 *
 * The spec says:
 *   - Token is "authority-only": it authorizes the request but does NOT taint
 *     the response (GoogleAuth(Alice) does not flow to response label).
 *   - Response gets its own label: EmailMetadataSecret(Alice).
 *
 * In our current architecture, this works because:
 *   - The recipe action reads the token (accumulates secret taint)
 *   - fetchData performs the actual fetch async in a NEW transaction
 *   - tryWriteResult writes the response in that new transaction (no taint)
 *   - The response cell has no ifc, so downstream reads are untainted
 *
 * This test verifies the full flow works with cfcEnabled: true.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setRecipeEnvironment } from "../src/env.ts";
import {
  CFCViolationError,
  createActionContext,
} from "../src/cfc/action-context.ts";
import {
  attachTaintContext,
  checkSinkAndWrite,
  checkTaintedWrite,
  detachTaintContext,
  recordTaintedRead,
} from "../src/cfc/taint-tracking.ts";
import {
  emptyLabel,
  type Label,
  labelFromClassification,
} from "../src/cfc/labels.ts";
import { emptyIntegrity } from "../src/cfc/integrity.ts";
import { serviceAtom, userAtom } from "../src/cfc/atoms.ts";
import type { ExchangeRule } from "../src/cfc/exchange-rules.ts";
import { createPolicy } from "../src/cfc/policy.ts";

const signer = await Identity.fromPassphrase("cfc gmail test");
const space = signer.did();

// ---------------------------------------------------------------------------
// Schemas modeling the Gmail OAuth flow
// ---------------------------------------------------------------------------

/** OAuth token schema — token field is secret (authority-only in spec terms) */
const oauthTokenSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      default: "",
      ifc: { classification: ["secret"] },
    },
    email: { type: "string", default: "" },
  },
} as const satisfies JSONSchema;

/** Email metadata schema — user-scoped, not secret */
const _emailMetadataSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          snippet: { type: "string" },
        },
      },
      default: [],
    },
  },
} as const satisfies JSONSchema;

// Mock Gmail API response
const MOCK_GMAIL_RESPONSE = {
  messages: [
    { id: "msg-001", threadId: "thread-001", snippet: "Meeting tomorrow" },
    { id: "msg-002", threadId: "thread-002", snippet: "Lunch plans" },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CFC Gmail Read Path", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnabled: true,
      cfcDebug: true,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe, byRef } = commontools);

    setRecipeEnvironment({
      apiUrl: new URL("http://mock-gmail.local"),
    });

    // Mock fetch to simulate Gmail API
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      await new Promise((resolve) => setTimeout(resolve, 10));

      return new Response(
        JSON.stringify(MOCK_GMAIL_RESPONSE),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("fetches Gmail messages with OAuth token, CFC enabled", async () => {
    // 1. Create OAuth token cell with secret-labeled token
    const tokenCell = runtime.getCell(
      space,
      "gmail-oauth-token",
      oauthTokenSchema,
      tx,
    );
    tokenCell.set({
      token: "ya29.mock-google-access-token",
      email: "alice@gmail.com",
    });
    tx.commit();
    await tokenCell.pull();
    tx = runtime.edit();

    // 2. Define recipe: read token → build URL + headers → fetchData
    const fetchData = byRef("fetchData");
    const gmailReadRecipe = recipe<{
      auth: { token: string; email: string };
    }>(
      "Gmail Read Messages",
      ({ auth }) => {
        // Build the fetch URL and options using the auth token
        const fetchParams = lift(
          (a: { token: string; email: string }) => ({
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            mode: "json" as const,
            options: {
              headers: {
                Authorization: `Bearer ${a.token}`,
              },
            },
          }),
        )(auth);

        // Call fetchData builtin
        return fetchData(fetchParams);
      },
    );

    // 3. Run the recipe
    const resultCell = runtime.getCell(
      space,
      "gmail-read-result",
      undefined,
      tx,
    );
    runtime.run(tx, gmailReadRecipe, { auth: tokenCell }, resultCell);
    tx.commit();

    // 4. Wait for async fetch to complete
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();

    // 5. Verify the fetch was called with the auth header
    expect(fetchCalls.length).toBeGreaterThan(0);
    const lastCall = fetchCalls[fetchCalls.length - 1];
    expect(lastCall.url).toContain("gmail.googleapis.com");
    expect(lastCall.init?.headers).toBeDefined();

    // 6. Verify the result contains Gmail messages
    const rawData = resultCell.get() as {
      pending: boolean;
      result: any;
      error: any;
    };
    expect(rawData.result).toBeDefined();
    expect(rawData.result.messages).toBeDefined();
    expect(rawData.result.messages.length).toBe(2);
    expect(rawData.result.messages[0].id).toBe("msg-001");
  });

  it("token taint does not leak to response (authority-only semantics)", async () => {
    // This test verifies that the fetchData builtin's async write path
    // does NOT carry the token's taint to the response. The token read
    // happens in the recipe action (tainted tx), but the response write
    // happens in a new transaction from tryWriteResult (no taint).

    const tokenCell = runtime.getCell(
      space,
      "gmail-oauth-token-2",
      oauthTokenSchema,
      tx,
    );
    tokenCell.set({
      token: "ya29.mock-token-authority-only",
      email: "alice@gmail.com",
    });
    tx.commit();
    await tokenCell.pull();
    tx = runtime.edit();

    const fetchData = byRef("fetchData");
    const gmailReadRecipe = recipe<{
      auth: { token: string; email: string };
    }>(
      "Gmail Authority-Only Test",
      ({ auth }) => {
        const fetchParams = lift(
          (a: { token: string; email: string }) => ({
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            mode: "json" as const,
            options: {
              headers: { Authorization: `Bearer ${a.token}` },
            },
          }),
        )(auth);
        return fetchData(fetchParams);
      },
    );

    const resultCell = runtime.getCell(
      space,
      "gmail-authority-result",
      undefined,
      tx,
    );
    runtime.run(tx, gmailReadRecipe, { auth: tokenCell }, resultCell);
    tx.commit();

    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();

    // Result should exist
    const rawData = resultCell.get() as { result: any };
    expect(rawData.result).toBeDefined();
    expect(rawData.result.messages).toBeDefined();

    // Now verify: reading the result cell in a fresh taint context
    // should NOT accumulate secret taint (because the result has no ifc)
    tx = runtime.edit();
    const ctx = createActionContext({ userDid: "did:alice", space });
    attachTaintContext(tx, ctx);

    // Read the result cell — should not taint
    const freshResult = resultCell.withTx(tx).get();
    expect(freshResult).toBeDefined();

    // Write to an unclassified target — should succeed because the
    // result cell doesn't carry secret taint from the token
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Unit-level Gmail flow tests (taint tracking layer)
// ---------------------------------------------------------------------------

describe("CFC Gmail Read Path: exchange rule flow", () => {
  function mockTx(): IExtendedStorageTransaction {
    return {} as IExtendedStorageTransaction;
  }

  it("authority-only token: taint stripped via exchange rule on response", () => {
    // Models the spec flow:
    //   S_token = { User(Alice), GoogleAuth(Alice) }
    //   Response gets: { User(Alice), EmailMetadataSecret(Alice) }
    //   Token's GoogleAuth taint is stripped by exchange rule

    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Reading the token accumulates: User(Alice) ∧ Service(google-auth)
    const tokenLabel: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, tokenLabel);

    // Without exchange rule, writing to User(Alice)-only target fails
    // because Service(google-auth) clause is not covered
    const userOnlyTarget: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, userOnlyTarget)).toThrow(
      CFCViolationError,
    );

    // Exchange rule: Service(google-auth) is authority-only — strip it
    // "If taint includes Service(X), the Service clause can be removed"
    const authorityOnlyRule: ExchangeRule = {
      confidentialityPre: [{ kind: "Service", params: { id: "$X" } }],
      integrityPre: [],
      removeMatchedClauses: true,
      addAlternatives: [],
      variables: ["$X"],
    };

    // With the exchange rule, write to User(Alice) target should succeed
    // because Service(google-auth) is stripped
    expect(() => checkTaintedWrite(tx, userOnlyTarget, [authorityOnlyRule])).not
      .toThrow();

    detachTaintContext(tx);
  });

  it("search query taint combines with response label", () => {
    // Models spec §1.3: read with secret query
    //   S_q = { NotesSecret(Alice) }  (modeled as Classification("secret"))
    //   Response = { User(Alice), EmailMetadataSecret(Alice), NotesSecret(Alice) }

    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Read email metadata (User-scoped)
    recordTaintedRead(tx, {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    });

    // Read secret search query — taints the action
    recordTaintedRead(tx, labelFromClassification("secret"));

    // Now accumulated taint is: User(Alice) ∧ secret
    // Writing to just User(Alice) target fails
    const userTarget: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, userTarget)).toThrow(CFCViolationError);

    // Writing to User(Alice) ∧ secret target succeeds
    const secretUserTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [{ kind: "Classification", level: "secret" }],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, secretUserTarget)).not.toThrow();

    detachTaintContext(tx);
  });

  it("sink declassification: token at header path stripped by sink rule", () => {
    // Google auth policy with sink rule: Service(google-auth) at
    // Authorization header is allowed for fetchData sink.
    const sinkRule: ExchangeRule = {
      confidentialityPre: [{ kind: "Service", params: { id: "google-auth" } }],
      integrityPre: [],
      addAlternatives: [],
      removeMatchedClauses: true,
      variables: [],
      allowedSink: "fetchData",
      allowedPaths: [["options", "headers", "Authorization"]],
    };
    const policy = createPolicy([sinkRule], 1);

    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token with path tracking → taint at header path
    const tokenLabel: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    const userOnlyTarget: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };

    // checkSinkAndWrite with "fetchData" → Service stripped → succeeds
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).not
      .toThrow();

    detachTaintContext(tx);
  });

  it("sink declassification: token at body path blocked by sink rule", () => {
    const sinkRule: ExchangeRule = {
      confidentialityPre: [{ kind: "Service", params: { id: "google-auth" } }],
      integrityPre: [],
      addAlternatives: [],
      removeMatchedClauses: true,
      variables: [],
      allowedSink: "fetchData",
      allowedPaths: [["options", "headers", "Authorization"]],
    };
    const policy = createPolicy([sinkRule], 1);

    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token at body path (NOT allowed)
    const tokenLabel: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, tokenLabel, ["options", "body"]);

    const userOnlyTarget: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };

    // Service(google-auth) NOT stripped at body → blocked
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("no ifc annotations: recipe without CFC labels works normally", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Read data with no ifc — empty label
    recordTaintedRead(tx, emptyLabel());

    // Write to any target — no restrictions
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();
    expect(() =>
      checkTaintedWrite(tx, {
        confidentiality: [[userAtom("did:alice")]],
        integrity: emptyIntegrity(),
      })
    ).not.toThrow();

    detachTaintContext(tx);
  });
});
