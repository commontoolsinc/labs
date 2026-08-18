import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  normalizeSourceId,
  sessionChunkCause,
  sessionKey,
} from "../src/session-contract.ts";

Deno.test("sessionKey is stable and cannot collide across source boundaries", () => {
  assertEquals(
    sessionKey("claude-code:default", "abc/123"),
    "claude-code%3Adefault/abc%2F123",
  );
  assertEquals(
    sessionKey("claude-code:default", "abc/123"),
    sessionKey("claude-code:default", "abc/123"),
  );
  assertEquals(normalizeSourceId("  Codex:Default  "), "codex:default");
});

Deno.test("session identity rejects empty and control-character values", () => {
  assertThrows(() => sessionKey("", "session"), Error, "sourceId");
  assertThrows(() => sessionKey("codex", ""), Error, "nativeSessionId");
  assertThrows(() => sessionKey("codex\nother", "session"), Error, "control");
});

Deno.test("session chunk identity includes its content hash", () => {
  const first = sessionChunkCause(
    "did:key:space",
    "codex",
    "session",
    0,
    "sha256:first",
  );
  const second = sessionChunkCause(
    "did:key:space",
    "codex",
    "session",
    0,
    "sha256:second",
  );
  assertEquals(first, {
    spaceDid: "did:key:space",
    agentConnector: "session-chunk",
    version: 1,
    sourceId: "codex",
    nativeSessionId: "session",
    part: 0,
    contentHash: "sha256:first",
  });
  assertNotEquals(first, second);
});
