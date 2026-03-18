import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import {
  type CfcIntentRequestSemantics,
  intentRequestSemanticsMatch,
} from "../src/cfc/intent-binding.ts";

describe("CFC intent request binding", () => {
  function createIntent() {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-binding-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-66",
        recipientSet: ["a@example.com"],
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-66" },
      ],
    });

    return createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-66",
        recipientSet: ["a@example.com"],
      },
      exp: 1_700_000_000_000 + 4_000,
      maxAttempts: 3,
      duration: "short",
    });
  }

  it("matches exact bound request semantics", () => {
    const intent = createIntent();
    const semantics: CfcIntentRequestSemantics = {
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      payloadDigest: intent.payloadDigest,
      idempotencyKey: intent.idempotencyKey,
    };

    expect(intentRequestSemanticsMatch(intent, semantics)).toBe(true);
  });

  it("rejects mismatched audience or endpoint", () => {
    const intent = createIntent();

    expect(
      intentRequestSemanticsMatch(intent, {
        audience: "https://evil.example",
        endpoint: "gmail.messages.send",
        payloadDigest: intent.payloadDigest,
        idempotencyKey: intent.idempotencyKey,
      }),
    ).toBe(false);

    expect(
      intentRequestSemanticsMatch(intent, {
        audience: "https://gmail.googleapis.com",
        endpoint: "gmail.messages.insert",
        payloadDigest: intent.payloadDigest,
        idempotencyKey: intent.idempotencyKey,
      }),
    ).toBe(false);
  });

  it("rejects mismatched payload or idempotency bindings", () => {
    const intent = createIntent();

    expect(
      intentRequestSemanticsMatch(intent, {
        audience: "https://gmail.googleapis.com",
        endpoint: "gmail.messages.send",
        payloadDigest: "cfc:intent-payload:wrong",
        idempotencyKey: intent.idempotencyKey,
      }),
    ).toBe(false);

    expect(
      intentRequestSemanticsMatch(intent, {
        audience: "https://gmail.googleapis.com",
        endpoint: "gmail.messages.send",
        payloadDigest: intent.payloadDigest,
        idempotencyKey: "cfc:intent-idempotency:wrong",
      }),
    ).toBe(false);
  });

  it("fails closed when required semantics are absent", () => {
    const intent = createIntent();

    expect(
      intentRequestSemanticsMatch(intent, {
        audience: "https://gmail.googleapis.com",
        endpoint: "gmail.messages.send",
      }),
    ).toBe(false);
  });
});
