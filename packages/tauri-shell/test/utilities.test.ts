/**
 * Tests for utility functions used in the passkey bridge
 *
 * These tests verify the base64url encoding/decoding and object conversion utilities.
 */

// Simple assertion functions to avoid network dependency
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    if (actual.length !== expected.length) {
      throw new Error(msg || `Arrays differ in length: ${actual.length} vs ${expected.length}`);
    }
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new Error(msg || `Arrays differ at index ${i}: ${actual[i]} vs ${expected[i]}`);
      }
    }
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      throw new Error(msg || `Arrays differ in length: ${actual.length} vs ${expected.length}`);
    }
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new Error(msg || `Arrays differ at index ${i}: ${actual[i]} vs ${expected[i]}`);
      }
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected} but got ${actual}`);
  }
}

// Base64URL encoding/decoding utilities (copied for testing since they're internal)
function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  base64 += "=".repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function convertToCamelCase<T extends object>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[camelKey] = convertToCamelCase(value as object);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

// ============================================================================
// Base64URL Encoding/Decoding Tests
// ============================================================================

Deno.test("base64UrlEncode encodes simple string correctly", () => {
  const input = new TextEncoder().encode("hello");
  const result = base64UrlEncode(input);
  assertEquals(result, "aGVsbG8");
});

Deno.test("base64UrlDecode decodes simple string correctly", () => {
  const input = "aGVsbG8";
  const result = base64UrlDecode(input);
  const decoded = new TextDecoder().decode(result);
  assertEquals(decoded, "hello");
});

Deno.test("base64UrlEncode/Decode roundtrip", () => {
  const original = "The quick brown fox jumps over the lazy dog";
  const bytes = new TextEncoder().encode(original);
  const encoded = base64UrlEncode(bytes);
  const decoded = base64UrlDecode(encoded);
  const result = new TextDecoder().decode(decoded);
  assertEquals(result, original);
});

Deno.test("base64UrlEncode handles binary data", () => {
  const bytes = new Uint8Array([0, 127, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
  const encoded = base64UrlEncode(bytes);
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded, bytes);
});

Deno.test("base64UrlEncode removes padding", () => {
  // "a" encodes to "YQ==" in standard base64
  const input = new TextEncoder().encode("a");
  const result = base64UrlEncode(input);
  assertEquals(result, "YQ"); // No padding
  assertEquals(result.includes("="), false);
});

Deno.test("base64UrlEncode replaces + with -", () => {
  // Values that would produce + in standard base64
  const input = new Uint8Array([251, 255]); // produces "+/8" in standard base64
  const result = base64UrlEncode(input);
  assertEquals(result.includes("+"), false);
});

Deno.test("base64UrlEncode replaces / with _", () => {
  // Values that would produce / in standard base64
  const input = new Uint8Array([251, 255]);
  const result = base64UrlEncode(input);
  assertEquals(result.includes("/"), false);
});

Deno.test("base64UrlDecode handles input without padding", () => {
  const encoded = "YQ"; // "a" without padding
  const decoded = base64UrlDecode(encoded);
  const result = new TextDecoder().decode(decoded);
  assertEquals(result, "a");
});

Deno.test("base64UrlDecode handles URL-safe characters", () => {
  // Create a string that uses - and _ in base64url
  const original = new Uint8Array([251, 255]);
  const encoded = base64UrlEncode(original);
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded, original);
});

Deno.test("base64UrlEncode handles empty input", () => {
  const input = new Uint8Array(0);
  const result = base64UrlEncode(input);
  assertEquals(result, "");
});

Deno.test("base64UrlDecode handles empty input", () => {
  const result = base64UrlDecode("");
  assertEquals(result.length, 0);
});

// ============================================================================
// convertToCamelCase Tests
// ============================================================================

Deno.test("convertToCamelCase converts snake_case to camelCase", () => {
  const input = { user_name: "test", display_name: "Test User" };
  const result = convertToCamelCase(input);
  assertEquals(result.userName, "test");
  assertEquals(result.displayName, "Test User");
});

Deno.test("convertToCamelCase handles nested objects", () => {
  const input = {
    outer_key: {
      inner_key: "value",
      another_key: 123,
    },
  };
  const result = convertToCamelCase(input);
  assertEquals((result.outerKey as Record<string, unknown>).innerKey, "value");
  assertEquals(
    (result.outerKey as Record<string, unknown>).anotherKey,
    123
  );
});

Deno.test("convertToCamelCase preserves arrays", () => {
  const input = { my_array: [1, 2, 3] };
  const result = convertToCamelCase(input);
  assertEquals(result.myArray, [1, 2, 3]);
});

Deno.test("convertToCamelCase handles already camelCase keys", () => {
  const input = { alreadyCamel: "value" };
  const result = convertToCamelCase(input);
  assertEquals(result.alreadyCamel, "value");
});

Deno.test("convertToCamelCase handles null values", () => {
  const input = { my_key: null };
  const result = convertToCamelCase(input);
  assertEquals(result.myKey, null);
});

Deno.test("convertToCamelCase handles undefined values", () => {
  const input = { my_key: undefined };
  const result = convertToCamelCase(input);
  assertEquals(result.myKey, undefined);
});

Deno.test("convertToCamelCase handles empty objects", () => {
  const input = {};
  const result = convertToCamelCase(input);
  assertEquals(Object.keys(result).length, 0);
});

Deno.test("convertToCamelCase handles multiple underscores", () => {
  const input = { my_long_key_name: "value" };
  const result = convertToCamelCase(input);
  assertEquals(result.myLongKeyName, "value");
});

Deno.test("convertToCamelCase preserves primitive types", () => {
  const input = {
    string_val: "hello",
    number_val: 42,
    boolean_val: true,
  };
  const result = convertToCamelCase(input);
  assertEquals(typeof result.stringVal, "string");
  assertEquals(typeof result.numberVal, "number");
  assertEquals(typeof result.booleanVal, "boolean");
});

// ============================================================================
// WebAuthn-specific encoding tests
// ============================================================================

Deno.test("base64UrlEncode handles typical credential ID length", () => {
  // Credential IDs are typically 32-64 bytes
  const credentialId = new Uint8Array(32);
  crypto.getRandomValues(credentialId);
  const encoded = base64UrlEncode(credentialId);
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded, credentialId);
});

Deno.test("base64UrlEncode handles challenge data", () => {
  // Challenges are typically 32 bytes
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const encoded = base64UrlEncode(challenge);
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded, challenge);
});
