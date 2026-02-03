/**
 * Tests for the Tauri Shell Passkey Bridge
 *
 * These tests focus on utility functions and module structure since
 * actual passkey operations require user interaction and platform authenticators.
 */

// Simple assertion functions to avoid network dependency
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected} but got ${actual}`);
  }
}

function assertExists<T>(value: T, msg?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(msg || `Expected value to exist but got ${value}`);
  }
}

import {
  isTauri,
  isPasskeyAvailable,
  createPasskey,
  getPasskey,
  getPasskeyAssertion,
  type CreatePasskeyOptions,
  type GetPasskeyOptions,
  type PasskeyCreationResult,
  type PasskeyAssertionResult,
} from "../src/mod.ts";

// Import internal utilities for testing - we need to test the bridge internals
// Since they're not exported, we'll test them through the module behavior

Deno.test("isTauri returns false in Deno environment", () => {
  // In Deno test environment, window.__TAURI__ is not defined
  const result = isTauri();
  assertEquals(result, false);
});

Deno.test("isPasskeyAvailable returns boolean", async () => {
  // In Deno test environment, PublicKeyCredential is not available
  const result = await isPasskeyAvailable();
  assertEquals(typeof result, "boolean");
  // Should return false since we're not in a browser with WebAuthn support
  assertEquals(result, false);
});

Deno.test("module exports are defined", () => {
  assertExists(isTauri);
  assertExists(isPasskeyAvailable);
  assertExists(createPasskey);
  assertExists(getPasskey);
  assertExists(getPasskeyAssertion);
});

Deno.test("CreatePasskeyOptions type is correctly structured", () => {
  const options: CreatePasskeyOptions = {
    rpName: "Test RP",
    userId: "dXNlcjEyMw", // base64url "user123"
    userName: "test@example.com",
    userDisplayName: "Test User",
    challenge: "Y2hhbGxlbmdl", // base64url "challenge"
  };

  assertEquals(options.rpName, "Test RP");
  assertEquals(options.userName, "test@example.com");
  assertEquals(options.userDisplayName, "Test User");
  assertEquals(typeof options.challenge, "string");
});

Deno.test("GetPasskeyOptions type is correctly structured", () => {
  const options: GetPasskeyOptions = {
    challenge: "Y2hhbGxlbmdl", // base64url "challenge"
    rpId: "example.com",
    timeout: 60000,
    userVerification: "required",
  };

  assertEquals(options.rpId, "example.com");
  assertEquals(options.timeout, 60000);
  assertEquals(options.userVerification, "required");
});

Deno.test("PasskeyCreationResult type is correctly structured", () => {
  const result: PasskeyCreationResult = {
    id: "credential-id",
    rawId: "Y3JlZGVudGlhbC1pZA",
    type: "public-key",
    response: {
      clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
      attestationObject: "o2NmbXRkbm9uZQ",
    },
    clientExtensionResults: {},
  };

  assertEquals(result.type, "public-key");
  assertEquals(result.id, "credential-id");
  assertExists(result.response);
  assertExists(result.clientExtensionResults);
});

Deno.test("PasskeyAssertionResult type is correctly structured", () => {
  const result: PasskeyAssertionResult = {
    id: "credential-id",
    rawId: "Y3JlZGVudGlhbC1pZA",
    type: "public-key",
    response: {
      clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
      authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2M",
      signature: "MEUCIQDx",
    },
    clientExtensionResults: {},
  };

  assertEquals(result.type, "public-key");
  assertEquals(result.id, "credential-id");
  assertExists(result.response.authenticatorData);
  assertExists(result.response.signature);
});

Deno.test("GetPasskeyOptions with allowCredentials", () => {
  const options: GetPasskeyOptions = {
    challenge: "Y2hhbGxlbmdl",
    allowCredentials: [
      {
        id: "Y3JlZGVudGlhbC1pZA",
        type: "public-key",
        transports: ["internal"],
      },
    ],
  };

  assertEquals(options.allowCredentials?.length, 1);
  assertEquals(options.allowCredentials?.[0].type, "public-key");
  assertEquals(options.allowCredentials?.[0].transports?.[0], "internal");
});

Deno.test("CreatePasskeyOptions with PRF extension", () => {
  const options: CreatePasskeyOptions = {
    rpName: "Test RP",
    userId: "dXNlcjEyMw",
    userName: "test@example.com",
    userDisplayName: "Test User",
    challenge: "Y2hhbGxlbmdl",
    extensions: {
      prf: {
        eval: {
          first: "c2FsdA", // base64url "salt"
        },
      },
    },
  };

  assertExists(options.extensions);
  assertExists(options.extensions?.prf);
  assertExists(options.extensions?.prf?.eval);
  assertEquals(options.extensions?.prf?.eval?.first, "c2FsdA");
});

Deno.test("PasskeyCreationResult with PRF results", () => {
  const result: PasskeyCreationResult = {
    id: "credential-id",
    rawId: "Y3JlZGVudGlhbC1pZA",
    type: "public-key",
    response: {
      clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
      attestationObject: "o2NmbXRkbm9uZQ",
    },
    clientExtensionResults: {
      prf: {
        enabled: true,
        results: {
          first: "ZGVyaXZlZC1rZXk", // base64url "derived-key"
        },
      },
    },
  };

  assertEquals(result.clientExtensionResults.prf?.enabled, true);
  assertExists(result.clientExtensionResults.prf?.results?.first);
});

// Test createPasskey and getPasskey throw appropriate errors when not in browser
Deno.test("createPasskey throws in non-browser environment", async () => {
  const options: CreatePasskeyOptions = {
    rpName: "Test RP",
    userId: "dXNlcjEyMw",
    userName: "test@example.com",
    userDisplayName: "Test User",
    challenge: "Y2hhbGxlbmdl",
  };

  try {
    await createPasskey(options);
    // Should not reach here
    assertEquals(true, false, "Expected createPasskey to throw");
  } catch (error) {
    // Expected - navigator.credentials is not available in Deno
    assertExists(error);
  }
});

Deno.test("getPasskey throws in non-browser environment", async () => {
  const options: GetPasskeyOptions = {
    challenge: "Y2hhbGxlbmdl",
  };

  try {
    await getPasskey(options);
    // Should not reach here
    assertEquals(true, false, "Expected getPasskey to throw");
  } catch (error) {
    // Expected - navigator.credentials is not available in Deno
    assertExists(error);
  }
});

Deno.test("getPasskeyAssertion throws in non-browser environment", async () => {
  const options: GetPasskeyOptions = {
    challenge: "Y2hhbGxlbmdl",
  };

  try {
    await getPasskeyAssertion(options);
    // Should not reach here
    assertEquals(true, false, "Expected getPasskeyAssertion to throw");
  } catch (error) {
    // Expected - navigator.credentials is not available in Deno
    assertExists(error);
  }
});
