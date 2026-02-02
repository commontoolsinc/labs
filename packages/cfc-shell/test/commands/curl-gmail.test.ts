/**
 * End-to-end Gmail read case test for curl.
 *
 * Exercises the full pipeline: curl with mock fetch, Authorization header,
 * policy exchange rules dropping GoogleAuth authority-only confidentiality.
 */

import { assertEquals } from "jsr:@std/assert";
import { VFS } from "../../src/vfs.ts";
import type { Atom, Label } from "../../src/labels.ts";
import { labels } from "../../src/labels.ts";
import { LabeledStream } from "../../src/labeled-stream.ts";
import { createEnvironment, type CommandContext } from "../../src/commands/context.ts";
import { curl } from "../../src/commands/network.ts";
import {
  pat,
  type ExchangeRule,
  type PolicyRecord,
} from "../../src/policy.ts";

// --- Atoms ---

function googleAuth(user: string): Atom {
  return { kind: "Policy", name: "GoogleAuth", subject: user, hash: "h" };
}

function user(did: string): Atom {
  return { kind: "PersonalSpace", did };
}

function googleAuthDropRule(u: string): ExchangeRule {
  return {
    name: "AuthorityOnlyDropGoogleAuth",
    preConf: [
      { kind: "Policy", name: pat.lit("GoogleAuth"), subject: pat.lit(u), hash: pat.lit("h") },
    ],
    preInteg: [
      { kind: "IntegrityToken", name: pat.lit("AuthorizedRequest") },
      { kind: "IntegrityToken", name: pat.lit("NetworkProvenance") },
    ],
    postConf: [],
    postInteg: [],
  };
}

function googleAuthPolicy(u: string): PolicyRecord {
  return {
    principal: googleAuth(u),
    exchangeRules: [googleAuthDropRule(u)],
  };
}

// --- Helpers ---

function mockFetch(body: string, status = 200): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url: string, _init?: RequestInit) => {
    return Promise.resolve(new Response(body, { status }));
  };
}

function createGmailContext(alice: string, mock: (url: string, init?: RequestInit) => Promise<Response>): {
  ctx: CommandContext;
  stdout: LabeledStream;
  stderr: LabeledStream;
} {
  const vfs = new VFS();
  const env = createEnvironment();
  const stdin = LabeledStream.empty();
  const stdout = new LabeledStream();
  const stderr = new LabeledStream();

  // pcLabel carries the token's confidentiality (simulating token in scope)
  const pcLabel: Label = {
    confidentiality: [[user(alice)], [googleAuth(alice)]],
    integrity: [],
  };

  const ctx: CommandContext = {
    vfs,
    env,
    stdin,
    stdout,
    stderr,
    pcLabel,
    requestIntent: async () => true,
    policies: [googleAuthPolicy(alice)],
    mockFetch: mock,
  };

  return { ctx, stdout, stderr };
}

// --- Tests ---

Deno.test("curl gmail: authorized fetch drops GoogleAuth confidentiality", async () => {
  const alice = "Alice";
  const gmailBody = JSON.stringify({ messages: [{ id: "msg1", snippet: "Hello" }] });
  const { ctx, stdout } = createGmailContext(alice, mockFetch(gmailBody));

  const result = await curl(
    ["-s", "-H", "Authorization: Bearer ya29.token", "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ctx,
  );

  assertEquals(result.exitCode, 0);

  // GoogleAuth should be dropped from output label
  assertEquals(result.label.confidentiality.length, 1, "Should have 1 confidentiality clause");
  assertEquals(result.label.confidentiality[0][0], user(alice), "Should be User(Alice)");

  // Integrity should have Origin + NetworkProvenance
  assertEquals(result.label.integrity.length, 2);
  assertEquals(result.label.integrity[0].kind, "Origin");
  assertEquals(result.label.integrity[1].kind, "NetworkProvenance");

  // Body should be written to stdout
  stdout.close();
  const output = await stdout.readAll();
  assertEquals(output.value, gmailBody);
});

Deno.test("curl gmail: no auth header — GoogleAuth preserved", async () => {
  const alice = "Alice";
  const { ctx } = createGmailContext(alice, mockFetch("{}"));

  // No -H Authorization header
  const result = await curl(
    ["-s", "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ctx,
  );

  assertEquals(result.exitCode, 0);
  // Without AuthorizedRequest boundary integrity, exchange rule doesn't fire
  assertEquals(result.label.confidentiality.length, 2, "Both clauses preserved");
});

Deno.test("curl gmail: output to file preserves label", async () => {
  const alice = "Alice";
  const gmailBody = '{"messages":[]}';
  const { ctx } = createGmailContext(alice, mockFetch(gmailBody));

  const result = await curl(
    ["-s", "-H", "Authorization: Bearer tok", "-o", "/tmp/gmail.json",
     "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ctx,
  );

  assertEquals(result.exitCode, 0);
  assertEquals(result.label.confidentiality.length, 1);

  // File should exist in VFS with the correct label
  const file = ctx.vfs.readFile("/tmp/gmail.json");
  assertEquals(new TextDecoder().decode(file.value), gmailBody);
  assertEquals(file.label.confidentiality.length, 1);
});

Deno.test("curl gmail: HTTP error with -f returns error code", async () => {
  const alice = "Alice";
  const { ctx, stderr } = createGmailContext(alice, mockFetch("Unauthorized", 401));

  const result = await curl(
    ["-f", "-H", "Authorization: Bearer expired", "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ctx,
  );

  assertEquals(result.exitCode, 22);

  stderr.close();
  const errOutput = await stderr.readAll();
  assertEquals(errOutput.value.includes("401"), true);
});

Deno.test("curl: mock fetch basic GET", async () => {
  const vfs = new VFS();
  const stdout = new LabeledStream();
  const stderr = new LabeledStream();

  const ctx: CommandContext = {
    vfs,
    env: createEnvironment(),
    stdin: LabeledStream.empty(),
    stdout,
    stderr,
    pcLabel: labels.bottom(),
    requestIntent: async () => true,
    mockFetch: mockFetch("hello world"),
  };

  const result = await curl(["-s", "https://example.com"], ctx);
  assertEquals(result.exitCode, 0);

  stdout.close();
  const output = await stdout.readAll();
  assertEquals(output.value, "hello world");
});
