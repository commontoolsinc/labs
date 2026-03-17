import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import {
  createCfcIntentOnce,
  deriveCfcIntentIdempotencyKey,
  verifyCfcShortIntentOnce,
} from "../src/cfc/intent-refinement.ts";

describe("CFC intent once helpers", () => {
  function createSourceIntent() {
    return createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-short-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-33",
        recipientSet: ["a@example.com"],
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-33" },
      ],
    });
  }

  it("derives stable idempotency keys from source intent and operation", () => {
    const sourceIntent = createSourceIntent();

    const keyA = deriveCfcIntentIdempotencyKey({
      sourceIntentId: sourceIntent.id,
      operation: "Gmail.Forward",
    });
    const keyB = deriveCfcIntentIdempotencyKey({
      sourceIntentId: sourceIntent.id,
      operation: "Gmail.Forward",
    });
    const keyC = deriveCfcIntentIdempotencyKey({
      sourceIntentId: sourceIntent.id,
      operation: "Gmail.Reply",
    });

    expect(keyA).toBe(keyB);
    expect(keyC).not.toBe(keyA);
  });

  it("creates short intent-once values with bound request semantics", () => {
    const sourceIntent = createSourceIntent();
    const now = 1_700_000_000_000;

    const intentOnce = createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-33",
        recipientSet: ["a@example.com"],
      },
      exp: now + 4_000,
      maxAttempts: 3,
      duration: "short",
    });

    expect(intentOnce.audience).toBe("https://gmail.googleapis.com");
    expect(intentOnce.endpoint).toBe("gmail.messages.send");
    expect(intentOnce.maxAttempts).toBe(3);
    expect(intentOnce.duration).toBe("short");
    expect(intentOnce.payloadDigest.length).toBeGreaterThan(0);
    expect(intentOnce.idempotencyKey).toBe(
      deriveCfcIntentIdempotencyKey({
        sourceIntentId: sourceIntent.id,
        operation: "Gmail.Forward",
      }),
    );
  });

  it("verifies short intents fail closed for long or expired windows", () => {
    const sourceIntent = createSourceIntent();
    const now = 1_700_000_000_000;

    const valid = createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-33",
        recipientSet: ["a@example.com"],
      },
      exp: now + 4_000,
      maxAttempts: 3,
      duration: "short",
    });
    const tooLong = createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-33",
        recipientSet: ["a@example.com"],
      },
      exp: now + 6_000,
      maxAttempts: 3,
      duration: "short",
    });
    const wrongDuration = createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-33",
        recipientSet: ["a@example.com"],
      },
      exp: now + 4_000,
      maxAttempts: 3,
      duration: "long",
    });

    expect(verifyCfcShortIntentOnce(valid, now)).toBe(true);
    expect(verifyCfcShortIntentOnce(tooLong, now)).toBe(false);
    expect(verifyCfcShortIntentOnce(wrongDuration, now)).toBe(false);
    expect(verifyCfcShortIntentOnce(valid, now + 4_001)).toBe(false);
  });
});
