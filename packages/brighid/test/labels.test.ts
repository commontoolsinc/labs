/**
 * Comprehensive tests for the CFC label algebra
 *
 * Tests cover:
 * - Label lattice properties (join/meet commutative, associative, idempotent)
 * - flowsTo properties (reflexive, transitive)
 * - Label constructors
 * - LabeledStream operations
 */

import { assert, assertEquals } from "@std/assert";
import { Label, labels } from "../src/labels.ts";
import { LabeledStream } from "../src/labeled-stream.ts";

// ============================================================================
// Helper Functions
// ============================================================================

function labelEqual(a: Label, b: Label): boolean {
  // Check confidentiality clauses (order doesn't matter)
  if (a.confidentiality.length !== b.confidentiality.length) return false;
  for (const clauseA of a.confidentiality) {
    const found = b.confidentiality.some((clauseB) =>
      clauseA.length === clauseB.length &&
      clauseA.every((atomA) => clauseB.some((atomB) => atomEqual(atomA, atomB)))
    );
    if (!found) return false;
  }

  // Check integrity atoms (order doesn't matter)
  if (a.integrity.length !== b.integrity.length) return false;
  for (const atomA of a.integrity) {
    if (!b.integrity.some((atomB) => atomEqual(atomA, atomB))) return false;
  }

  return true;
}

function atomEqual(a: any, b: any): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "Origin":
      return a.url === b.url;
    case "CodeHash":
      return a.hash === b.hash;
    case "EndorsedBy":
      return a.principal === b.principal;
    case "AuthoredBy":
      return a.principal === b.principal;
    case "LLMGenerated":
      return a.model === b.model;
    case "UserInput":
      return true;
    case "NetworkProvenance":
      return a.tls === b.tls && a.host === b.host;
    case "TransformedBy":
      return a.command === b.command;
    case "Space":
      return a.id === b.id;
    case "PersonalSpace":
      return a.did === b.did;
    case "SandboxedExec":
      return true;
    case "InjectionFree":
      return true;
    case "InfluenceClean":
      return true;
    case "Custom":
      return a.tag === b.tag && a.value === b.value;
    default:
      return false;
  }
}

// ============================================================================
// Join Properties
// ============================================================================

Deno.test("join is commutative", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");

  const ab = labels.join(a, b);
  const ba = labels.join(b, a);

  assert(labelEqual(ab, ba), "join(a,b) should equal join(b,a)");
});

Deno.test("join is associative", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");
  const c = labels.fromNetwork("https://example.com", true);

  const ab_c = labels.join(labels.join(a, b), c);
  const a_bc = labels.join(a, labels.join(b, c));

  assert(
    labelEqual(ab_c, a_bc),
    "join(join(a,b),c) should equal join(a,join(b,c))",
  );
});

Deno.test("join is idempotent", () => {
  const a = labels.userInput();
  const aa = labels.join(a, a);

  assert(labelEqual(a, aa), "join(a,a) should equal a");
});

// ============================================================================
// Meet Properties
// ============================================================================

Deno.test("meet is commutative", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");

  const ab = labels.meet(a, b);
  const ba = labels.meet(b, a);

  assert(labelEqual(ab, ba), "meet(a,b) should equal meet(b,a)");
});

Deno.test("meet is associative", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");
  const c = labels.fromNetwork("https://example.com", true);

  const ab_c = labels.meet(labels.meet(a, b), c);
  const a_bc = labels.meet(a, labels.meet(b, c));

  assert(
    labelEqual(ab_c, a_bc),
    "meet(meet(a,b),c) should equal meet(a,meet(b,c))",
  );
});

Deno.test("meet is idempotent", () => {
  const a = labels.userInput();
  const aa = labels.meet(a, a);

  assert(labelEqual(a, aa), "meet(a,a) should equal a");
});

// ============================================================================
// flowsTo Properties
// ============================================================================

Deno.test("flowsTo is reflexive", () => {
  const a = labels.userInput();
  assert(labels.flowsTo(a, a), "flowsTo(a,a) should be true");
});

Deno.test("flowsTo is transitive", () => {
  // Create labels with nested confidentiality requirements
  const a: Label = {
    confidentiality: [],
    integrity: [],
  };

  const b: Label = {
    confidentiality: [[{ kind: "Space", id: "space1" }]],
    integrity: [],
  };

  const c: Label = {
    confidentiality: [
      [{ kind: "Space", id: "space1" }],
      [{ kind: "Space", id: "space2" }],
    ],
    integrity: [],
  };

  assert(labels.flowsTo(a, b), "a should flow to b");
  assert(labels.flowsTo(b, c), "b should flow to c");
  assert(labels.flowsTo(a, c), "a should flow to c (transitivity)");
});

Deno.test("join preserves flowsTo", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");

  const joined = labels.join(a, b);

  assert(labels.flowsTo(a, joined), "a should flow to join(a,b)");
  assert(labels.flowsTo(b, joined), "b should flow to join(a,b)");
});

// ============================================================================
// Endorse
// ============================================================================

Deno.test("endorse adds integrity without changing confidentiality", () => {
  const original = labels.fromNetwork("https://example.com", true);
  const endorsed = labels.endorse(
    original,
    { kind: "EndorsedBy", principal: "user@example.com" },
  );

  // Confidentiality should be unchanged
  assertEquals(
    endorsed.confidentiality.length,
    original.confidentiality.length,
    "Confidentiality should not change",
  );

  // Integrity should be increased
  assert(
    endorsed.integrity.length > original.integrity.length,
    "Integrity should be increased",
  );

  assert(
    labels.hasIntegrity(endorsed, {
      kind: "EndorsedBy",
      principal: "user@example.com",
    }),
    "Should have the new integrity atom",
  );
});

// ============================================================================
// Label Constructors
// ============================================================================

Deno.test("userInput has UserInput integrity", () => {
  const label = labels.userInput();

  assert(
    labels.hasIntegrity(label, { kind: "UserInput" }),
    "Should have UserInput integrity",
  );

  assertEquals(label.confidentiality.length, 0, "Should be public");
});

Deno.test("fromNetwork has Origin + NetworkProvenance integrity", () => {
  const url = "https://example.com/data";
  const label = labels.fromNetwork(url, true);

  assert(
    labels.hasIntegrity(label, { kind: "Origin", url }),
    "Should have Origin integrity",
  );

  assert(
    labels.hasIntegrity(label, {
      kind: "NetworkProvenance",
      tls: true,
      host: "example.com",
    }),
    "Should have NetworkProvenance integrity",
  );

  assertEquals(label.confidentiality.length, 0, "Should be public");
});

Deno.test("fromNetwork handles non-TLS URLs", () => {
  const url = "http://insecure.com/data";
  const label = labels.fromNetwork(url, false);

  assert(
    labels.hasIntegrity(label, {
      kind: "NetworkProvenance",
      tls: false,
      host: "insecure.com",
    }),
    "Should have non-TLS NetworkProvenance",
  );
});

Deno.test("llmGenerated has LLMGenerated integrity", () => {
  const label = labels.llmGenerated("gpt-4");

  assert(
    labels.hasIntegrity(label, { kind: "LLMGenerated", model: "gpt-4" }),
    "Should have LLMGenerated integrity with model",
  );

  assertEquals(label.confidentiality.length, 0, "Should be public");
});

Deno.test("llmGenerated without model", () => {
  const label = labels.llmGenerated();

  assert(
    labels.hasIntegrity(label, { kind: "LLMGenerated" }),
    "Should have LLMGenerated integrity without model",
  );
});

Deno.test("fromFile with spaceId has Space confidentiality", () => {
  const label = labels.fromFile("/path/to/file", "space123");

  assertEquals(
    label.confidentiality.length,
    1,
    "Should have one confidentiality clause",
  );
  assertEquals(
    label.confidentiality[0].length,
    1,
    "Clause should have one atom",
  );
  assertEquals(
    label.confidentiality[0][0].kind,
    "Space",
    "Should be Space atom",
  );
  assertEquals(
    (label.confidentiality[0][0] as any).id,
    "space123",
    "Should have correct space ID",
  );
});

Deno.test("fromFile without spaceId is public", () => {
  const label = labels.fromFile("/path/to/file");

  assertEquals(label.confidentiality.length, 0, "Should be public");
});

Deno.test("joinAll of empty returns bottom", () => {
  const result = labels.joinAll([]);
  const expected = labels.bottom();

  assert(labelEqual(result, expected), "joinAll([]) should equal bottom()");
});

Deno.test("joinAll joins multiple labels correctly", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");
  const c = labels.fromNetwork("https://example.com", true);

  const joined = labels.joinAll([a, b, c]);

  // Should have no integrity (intersection of all three)
  assertEquals(
    joined.integrity.length,
    0,
    "Should have no shared integrity atoms",
  );

  // Should be public (all three are public)
  assertEquals(joined.confidentiality.length, 0, "Should be public");
});

// ============================================================================
// Confidentiality Flow Control
// ============================================================================

Deno.test("public data flows to private context", () => {
  const public_label = labels.bottom();
  const private_label = labels.fromFile("/secret", "private-space");

  assert(
    labels.flowsTo(public_label, private_label),
    "Public data should flow to private context",
  );
});

Deno.test("private data does not flow to public context", () => {
  const private_label = labels.fromFile("/secret", "private-space");
  const public_label = labels.bottom();

  assert(
    !labels.flowsTo(private_label, public_label),
    "Private data should not flow to public context",
  );
});

Deno.test("data flows to context with same confidentiality", () => {
  const label_a = labels.fromFile("/file1", "space1");
  const label_b = labels.fromFile("/file2", "space1");

  assert(
    labels.flowsTo(label_a, label_b),
    "Data should flow to context with same confidentiality",
  );
});

// ============================================================================
// Integrity Operations
// ============================================================================

Deno.test("hasAnyIntegrity checks for any of given atoms", () => {
  const label = labels.fromNetwork("https://example.com", true);

  assert(
    labels.hasAnyIntegrity(label, [
      { kind: "Origin", url: "https://example.com" },
      { kind: "UserInput" },
    ]),
    "Should have at least one of the atoms",
  );

  assert(
    !labels.hasAnyIntegrity(label, [
      { kind: "UserInput" },
      { kind: "LLMGenerated" },
    ]),
    "Should not have any of these atoms",
  );
});

Deno.test("join reduces integrity (intersection)", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");

  const joined = labels.join(a, b);

  // No shared integrity atoms
  assertEquals(
    joined.integrity.length,
    0,
    "Join should have no integrity (intersection is empty)",
  );
});

Deno.test("meet increases integrity (union)", () => {
  const a = labels.userInput();
  const b = labels.llmGenerated("gpt-4");

  const met = labels.meet(a, b);

  // Should have both integrity atoms
  assert(
    labels.hasIntegrity(met, { kind: "UserInput" }),
    "Should have UserInput integrity",
  );
  assert(
    labels.hasIntegrity(met, { kind: "LLMGenerated", model: "gpt-4" }),
    "Should have LLMGenerated integrity",
  );
});

// ============================================================================
// LabeledStream Tests
// ============================================================================

Deno.test("LabeledStream: write and readAll joins labels correctly", async () => {
  const stream = new LabeledStream();

  const label1 = labels.userInput();
  const label2 = labels.llmGenerated("gpt-4");

  stream.write("Hello ", label1);
  stream.write("World", label2);
  stream.close();

  const result = await stream.readAll();

  assertEquals(result.value, "Hello World", "Should concatenate data");

  // Labels should be joined
  const expectedLabel = labels.join(label1, label2);
  assert(
    labelEqual(result.label, expectedLabel),
    "Labels should be joined",
  );
});

Deno.test("LabeledStream: read returns chunks in order", async () => {
  const stream = new LabeledStream();

  const label1 = labels.userInput();
  const label2 = labels.llmGenerated("gpt-4");

  stream.write("first", label1);
  stream.write("second", label2);
  stream.close();

  const chunk1 = await stream.read();
  assertEquals(chunk1?.data, "first", "First chunk should be 'first'");
  assert(labelEqual(chunk1!.label, label1), "First chunk should have label1");

  const chunk2 = await stream.read();
  assertEquals(chunk2?.data, "second", "Second chunk should be 'second'");
  assert(labelEqual(chunk2!.label, label2), "Second chunk should have label2");

  const chunk3 = await stream.read();
  assertEquals(chunk3, null, "Should return null after stream is closed");
});

Deno.test("LabeledStream: read waits for data", async () => {
  const stream = new LabeledStream();

  // Start reading before data is available
  const readPromise = stream.read();

  // Write data after a delay
  setTimeout(() => {
    stream.write("delayed", labels.userInput());
  }, 10);

  const chunk = await readPromise;
  assertEquals(chunk?.data, "delayed", "Should receive delayed data");
});

Deno.test("LabeledStream: close signals EOF", async () => {
  const stream = new LabeledStream();
  stream.close();

  const chunk = await stream.read();
  assertEquals(
    chunk,
    null,
    "Should return null when reading from closed empty stream",
  );
});

Deno.test("LabeledStream: cannot write after close", () => {
  const stream = new LabeledStream();
  stream.close();

  let errorThrown = false;
  try {
    stream.write("data", labels.bottom());
  } catch {
    errorThrown = true;
  }

  assert(errorThrown, "Should throw error when writing to closed stream");
});

Deno.test("LabeledStream.from creates stream from labeled value", async () => {
  const labeled = {
    value: "test data",
    label: labels.userInput(),
  };

  const stream = LabeledStream.from(labeled);
  const result = await stream.readAll();

  assertEquals(result.value, labeled.value, "Should have same value");
  assert(labelEqual(result.label, labeled.label), "Should have same label");
});

Deno.test("LabeledStream.empty creates closed empty stream", async () => {
  const stream = LabeledStream.empty();

  assert(stream.closed, "Stream should be closed");

  const result = await stream.readAll();
  assertEquals(result.value, "", "Should have empty value");
  assert(labelEqual(result.label, labels.bottom()), "Should have bottom label");
});

Deno.test("LabeledStream: multiple readers wait in queue", async () => {
  const stream = new LabeledStream();

  // Start multiple reads
  const read1 = stream.read();
  const read2 = stream.read();

  // Write data
  stream.write("first", labels.userInput());
  stream.write("second", labels.llmGenerated());

  const chunk1 = await read1;
  const chunk2 = await read2;

  assertEquals(chunk1?.data, "first", "First reader should get first chunk");
  assertEquals(chunk2?.data, "second", "Second reader should get second chunk");
});

Deno.test("LabeledStream: readAll on empty stream returns empty", async () => {
  const stream = new LabeledStream();
  stream.close();

  const result = await stream.readAll();
  assertEquals(result.value, "", "Should have empty value");
  assert(labelEqual(result.label, labels.bottom()), "Should have bottom label");
});

// ============================================================================
// Complex Scenarios
// ============================================================================

Deno.test("Complex: data from multiple sources through pipe", () => {
  // Simulate: cat user_file.txt | grep pattern | process
  const userFile = labels.fromFile("/user_file.txt", "user-space");
  const grepPattern = labels.userInput(); // User provided pattern

  // cat outputs the file
  const catOutput = userFile;

  // grep joins file and pattern labels
  const grepOutput = labels.join(catOutput, grepPattern);

  // process adds transformation
  const processOutput = labels.endorse(grepOutput, {
    kind: "TransformedBy",
    command: "process",
  });

  // Final output should:
  // - Have user-space confidentiality (from file)
  // - Have TransformedBy integrity
  // - Not have UserInput integrity (lost in join)

  assertEquals(
    processOutput.confidentiality.length,
    1,
    "Should preserve confidentiality",
  );
  assert(
    labels.hasIntegrity(processOutput, {
      kind: "TransformedBy",
      command: "process",
    }),
    "Should have TransformedBy integrity",
  );
  assert(
    !labels.hasIntegrity(processOutput, { kind: "UserInput" }),
    "Should not have UserInput integrity (lost in join)",
  );
});

Deno.test("Complex: prevent data exfiltration", () => {
  // Secret file with high confidentiality
  const secret = labels.fromFile("/etc/secrets/api_key", "secret-space");

  // Network target is public
  const networkTarget = labels.bottom();

  // Secret should not flow to public network
  assert(
    !labels.flowsTo(secret, networkTarget),
    "Secret data should not flow to public network",
  );

  // This would be blocked by exchange rules in practice
});

Deno.test("Complex: untrusted data should not execute", () => {
  // Data from untrusted network
  const untrusted = labels.fromNetwork("https://evil.com/script", true);

  // Check if it has required integrity for execution
  const hasUserEndorsement = labels.hasIntegrity(
    untrusted,
    { kind: "EndorsedBy", principal: "user" },
  );

  assert(
    !hasUserEndorsement,
    "Untrusted network data should not have user endorsement",
  );

  // Would require explicit endorsement to execute
  const endorsed = labels.endorse(
    untrusted,
    { kind: "EndorsedBy", principal: "user" },
  );

  assert(
    labels.hasIntegrity(endorsed, { kind: "EndorsedBy", principal: "user" }),
    "Explicitly endorsed data can execute",
  );
});

// ============================================================================
// Injection / Influence Integrity Tests
// ============================================================================

Deno.test("clean() has both InjectionFree and InfluenceClean", () => {
  const label = labels.clean();

  assert(
    labels.hasIntegrity(label, { kind: "InjectionFree" }),
    "Should have InjectionFree",
  );
  assert(
    labels.hasIntegrity(label, { kind: "InfluenceClean" }),
    "Should have InfluenceClean",
  );
  assert(
    labels.hasIntegrity(label, { kind: "UserInput" }),
    "Should have UserInput",
  );
});

Deno.test("userInput() now has InjectionFree and InfluenceClean", () => {
  const label = labels.userInput();

  assert(
    labels.hasIntegrity(label, { kind: "UserInput" }),
    "Should have UserInput",
  );
  assert(
    labels.hasIntegrity(label, { kind: "InjectionFree" }),
    "Should have InjectionFree",
  );
  assert(
    labels.hasIntegrity(label, { kind: "InfluenceClean" }),
    "Should have InfluenceClean",
  );
});

Deno.test("stripInjectionIntegrity removes both InjectionFree and InfluenceClean", () => {
  const label = labels.userInput();
  const stripped = labels.stripInjectionIntegrity(label);

  assert(
    !labels.hasIntegrity(stripped, { kind: "InjectionFree" }),
    "Should not have InjectionFree",
  );
  assert(
    !labels.hasIntegrity(stripped, { kind: "InfluenceClean" }),
    "Should not have InfluenceClean",
  );
  assert(
    labels.hasIntegrity(stripped, { kind: "UserInput" }),
    "Should still have UserInput",
  );
});

Deno.test("stripInfluenceClean removes only InfluenceClean, keeps InjectionFree", () => {
  const label = labels.userInput();
  const stripped = labels.stripInfluenceClean(label);

  assert(
    labels.hasIntegrity(stripped, { kind: "InjectionFree" }),
    "Should still have InjectionFree",
  );
  assert(
    !labels.hasIntegrity(stripped, { kind: "InfluenceClean" }),
    "Should not have InfluenceClean",
  );
  assert(
    labels.hasIntegrity(stripped, { kind: "UserInput" }),
    "Should still have UserInput",
  );
});

Deno.test("join(clean, llmGenerated) loses both injection atoms", () => {
  const c = labels.clean();
  const llm = labels.llmGenerated("gpt-4");
  const joined = labels.join(c, llm);

  assert(
    !labels.hasIntegrity(joined, { kind: "InjectionFree" }),
    "Should not have InjectionFree after join with LLM",
  );
  assert(
    !labels.hasIntegrity(joined, { kind: "InfluenceClean" }),
    "Should not have InfluenceClean after join with LLM",
  );
});

Deno.test("influenceTainted() has InjectionFree but NOT InfluenceClean", () => {
  const label = labels.influenceTainted();

  assert(
    labels.hasIntegrity(label, { kind: "InjectionFree" }),
    "Should have InjectionFree",
  );
  assert(
    !labels.hasIntegrity(label, { kind: "InfluenceClean" }),
    "Should not have InfluenceClean",
  );
});
