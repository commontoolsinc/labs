/**
 * Agent System Tests
 *
 * Tests the agent protocol's visibility filtering, sub-agent spawning,
 * structural return channel, and label tracking.
 *
 * Run with: deno test --allow-env --allow-read --allow-write test/agent.test.ts
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { AgentSession } from "../src/agent/agent-session.ts";
import {
  AgentPolicy,
  policies,
  checkVisibility,
  filterOutput,
} from "../src/agent/policy.ts";
import { AgentCLI } from "../src/agent/cli.ts";
import { labels, type Label } from "../src/labels.ts";
import { VFS } from "../src/vfs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a VFS pre-populated with test files carrying specific labels. */
function makeVFS(
  files: Record<string, { content: string; label: Label }>,
): VFS {
  const vfs = new VFS();
  for (const [path, { content, label }] of Object.entries(files)) {
    vfs.writeFile(path, content, label);
  }
  return vfs;
}

/** Shorthand labels used throughout the tests. */
const userLabel = () => labels.userInput(); // Has InjectionFree + InfluenceClean
const networkLabel = () =>
  labels.fromNetwork("https://example.com/page", true); // Lacks injection atoms
const llmLabel = () => labels.llmGenerated("test-model"); // Lacks injection atoms

// ============================================================================
// Policy Tests
// ============================================================================

Deno.test("checkVisibility returns null for data satisfying policy", () => {
  // User-input data carries InjectionFree, satisfying the main policy's "any" mode.
  const label = userLabel();
  const result = checkVisibility(label, policies.main());
  assertEquals(result, null, "User input should satisfy main policy");
});

Deno.test("checkVisibility returns reason for data violating policy", () => {
  // Network data lacks both InjectionFree and TransformedBy.
  const label = networkLabel();
  const result = checkVisibility(label, policies.main());
  assertEquals(
    typeof result,
    "string",
    "Network data should fail main policy check",
  );
});

Deno.test("checkVisibility allows everything for empty requirements", () => {
  const emptyPolicy = policies.sub();
  assertEquals(
    checkVisibility(networkLabel(), emptyPolicy),
    null,
    "Empty requirements should allow everything",
  );
  assertEquals(
    checkVisibility(llmLabel(), emptyPolicy),
    null,
    "Empty requirements should allow LLM data too",
  );
});

Deno.test("checkVisibility accepts TransformedBy as alternative to InjectionFree", () => {
  // Data with TransformedBy should satisfy the main policy (mode: "any").
  const label: Label = {
    confidentiality: [],
    integrity: [{ kind: "TransformedBy", command: "agent-1" }],
  };
  const result = checkVisibility(label, policies.main());
  assertEquals(result, null, "TransformedBy should satisfy main policy");
});

Deno.test("filterOutput passes through visible data", () => {
  const content = "trusted user input data";
  const result = filterOutput(content, userLabel(), policies.main());
  assertEquals(result.content, content, "Content should be unchanged");
  assertEquals(result.filtered, false, "filtered flag should be false");
});

Deno.test("filterOutput redacts invisible data", () => {
  const content = "<script>prompt injection payload</script>";
  const result = filterOutput(content, networkLabel(), policies.main());
  assertStringIncludes(
    result.content,
    "[FILTERED:",
    "Content should be replaced with FILTERED marker",
  );
  assertEquals(result.filtered, true, "filtered flag should be true");
});

// ============================================================================
// AgentSession Tests
// ============================================================================

Deno.test("main agent sees injection-free data", async () => {
  const vfs = makeVFS({
    "/data/safe.txt": { content: "safe content", label: userLabel() },
  });
  const agent = new AgentSession({ policy: policies.main(), vfs });
  const result = await agent.exec("cat /data/safe.txt");

  assertStringIncludes(
    result.stdout,
    "safe content",
    "Main agent should see injection-free file content",
  );
  assertEquals(result.filtered, false, "Should not be filtered");
});

Deno.test(
  "main agent gets filtered output for injection-tainted data",
  async () => {
    const vfs = makeVFS({
      "/data/untrusted.html": {
        content: "<script>alert('xss')</script>",
        label: networkLabel(),
      },
    });
    const agent = new AgentSession({ policy: policies.main(), vfs });
    const result = await agent.exec("cat /data/untrusted.html");

    assertStringIncludes(
      result.stdout,
      "[FILTERED:",
      "Main agent should see FILTERED marker for tainted data",
    );
    assertEquals(result.filtered, true, "Should be marked as filtered");
  },
);

Deno.test("sub-agent sees injection-tainted data", async () => {
  const vfs = makeVFS({
    "/data/untrusted.html": {
      content: "network content here",
      label: networkLabel(),
    },
  });
  const parent = new AgentSession({ policy: policies.main(), vfs });
  const sub = parent.spawnSubAgent();
  const result = await sub.exec("cat /data/untrusted.html");

  assertStringIncludes(
    result.stdout,
    "network content here",
    "Sub-agent should see the actual untrusted content",
  );
  assertEquals(result.filtered, false, "Sub-agent should not filter this data");
});

Deno.test("sub-agent returnResult makes data visible to parent", async () => {
  // Security property: sub-agent processes untrusted data, then returns
  // a result via the structural return channel. The system labels it with
  // TransformedBy, which satisfies the parent's "any" policy.
  const vfs = makeVFS({
    "/data/reviewed.txt": {
      content: "reviewed safe content",
      label: networkLabel(),
    },
  });
  const parent = new AgentSession({ policy: policies.main(), vfs });
  const sub = parent.spawnSubAgent();

  // Sub-agent reads untrusted data
  await sub.exec("cat /data/reviewed.txt");

  // Sub-agent returns result via return channel
  sub.returnResult("/tmp/result.txt", "reviewed safe content");

  // Parent should see it (TransformedBy satisfies policy)
  const result = await parent.exec("cat /tmp/result.txt");
  assertStringIncludes(
    result.stdout,
    "reviewed safe content",
    "Parent should see returned content",
  );
  assertEquals(result.filtered, false, "Returned data should not be filtered");
});

Deno.test("main agent cannot use return channel", async () => {
  // Only sub-agents can use the return channel.
  const agent = new AgentSession({ policy: policies.main() });

  let errorThrown = false;
  try {
    agent.returnResult("/tmp/result.txt", "some content");
  } catch (_e) {
    errorThrown = true;
  }
  assertEquals(
    errorThrown,
    true,
    "Main agent should not be allowed to use return channel",
  );
});

Deno.test("readFile filters based on policy", async () => {
  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "tainted data",
      label: networkLabel(),
    },
  });

  const mainAgent = new AgentSession({ policy: policies.main(), vfs });
  const mainResult = mainAgent.readFile("/data/tainted.txt");
  assertEquals(
    mainResult.filtered,
    true,
    "Main agent readFile should report filtered=true for tainted data",
  );

  const sub = mainAgent.spawnSubAgent();
  const subResult = sub.readFile("/data/tainted.txt");
  assertEquals(
    subResult.filtered,
    false,
    "Sub-agent readFile should report filtered=false for same data",
  );
});

Deno.test("label inspect shows label info", async () => {
  const vfs = makeVFS({
    "/data/file.txt": {
      content: "some content",
      label: userLabel(),
    },
  });
  const agent = new AgentSession({ policy: policies.main(), vfs });
  const result = await agent.exec("!label /data/file.txt");

  assertStringIncludes(
    result.stdout,
    "InjectionFree",
    "Label inspect should show InjectionFree atom",
  );
  assertStringIncludes(
    result.stdout,
    "UserInput",
    "Label inspect should show UserInput atom",
  );
});

// ============================================================================
// Sub-agent Hierarchy Tests
// ============================================================================

Deno.test("spawnSubAgent creates child with shared VFS", async () => {
  const vfs = makeVFS({
    "/shared/data.txt": {
      content: "shared data",
      label: userLabel(),
    },
  });
  const parent = new AgentSession({ policy: policies.main(), vfs });
  const child = parent.spawnSubAgent();

  const result = await child.exec("cat /shared/data.txt");
  assertStringIncludes(
    result.stdout,
    "shared data",
    "Child should be able to read files from the shared VFS",
  );
});

Deno.test(
  "sub-agent writes are visible to parent (with filtering)",
  async () => {
    // When a sub-agent writes via normal shell commands, the output
    // inherits taint. Parent sees FILTERED unless sub-agent uses return channel.
    const vfs = makeVFS({
      "/data/untrusted.txt": {
        content: "untrusted content",
        label: networkLabel(),
      },
    });
    const parent = new AgentSession({ policy: policies.main(), vfs });
    const sub = parent.spawnSubAgent();

    await sub.exec("cat /data/untrusted.txt");
    await sub.exec('echo "summary of untrusted" > /tmp/summary.txt');

    // Parent tries to read — should be filtered (no TransformedBy or InjectionFree)
    const parentResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      parentResult.stdout,
      "[FILTERED:",
      "Parent should see FILTERED marker for tainted sub-agent output",
    );
  },
);

Deno.test(
  "sub-agent return channel makes data visible to parent",
  async () => {
    // Full return channel flow: sub-agent processes untrusted data,
    // returns a clean summary via the return channel.
    const vfs = makeVFS({
      "/inbox/email.html": {
        content: "<p>meeting at 3pm</p>",
        label: networkLabel(),
      },
    });
    const parent = new AgentSession({ policy: policies.main(), vfs });
    const sub = parent.spawnSubAgent();

    // Sub-agent reads and processes
    await sub.exec("cat /inbox/email.html");

    // Normal write — parent can't see it
    await sub.exec('echo "Meeting at 3pm" > /tmp/summary.txt');
    const beforeResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      beforeResult.stdout,
      "[FILTERED:",
      "Before return, parent should see FILTERED",
    );

    // Sub-agent returns result via return channel
    sub.returnResult("/tmp/summary.txt", "Meeting at 3pm");

    // After return, parent can see it
    const afterResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      afterResult.stdout,
      "Meeting at 3pm",
      "After return, parent should see actual content",
    );
    assertEquals(
      afterResult.filtered,
      false,
      "After return, filtered should be false",
    );
  },
);

// ============================================================================
// CLI Tests
// ============================================================================

Deno.test("CLI processLine executes commands", async () => {
  const cli = new AgentCLI({ policy: policies.sub() });
  const output = await cli.processLine("echo hello");
  assertStringIncludes(output, "hello", "CLI should execute echo command");
});

Deno.test("CLI processLine handles !sub and !end", async () => {
  const cli = new AgentCLI({});
  const subOutput = await cli.processLine("!sub");
  assertStringIncludes(
    subOutput,
    "sub",
    "!sub should acknowledge sub-agent creation",
  );

  const endOutput = await cli.processLine("!end");
  assertStringIncludes(
    endOutput,
    "end",
    "!end should acknowledge return to parent",
  );
});

Deno.test("CLI processLine handles !policy", async () => {
  const cli = new AgentCLI({});
  const output = await cli.processLine("!policy");
  assertStringIncludes(
    output,
    "InjectionFree",
    "!policy should show the main policy requirements",
  );
});

Deno.test("CLI processLine filters tainted data", async () => {
  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "evil payload",
      label: networkLabel(),
    },
  });
  const cli = new AgentCLI({ vfs });
  const output = await cli.processLine("cat /data/tainted.txt");
  assertStringIncludes(
    output,
    "[FILTERED:",
    "CLI should filter tainted data for the main agent",
  );
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test("full agent workflow: triage untrusted content via return channel", async () => {
  // End-to-end scenario:
  // 1. A webpage is fetched from the network (carries NetworkProvenance, no InjectionFree)
  // 2. Main agent tries to read it -> gets FILTERED
  // 3. Main agent spawns sub-agent
  // 4. Sub-agent reads the webpage -> sees actual content
  // 5. Sub-agent returns a triage summary via the return channel
  // 6. Main agent reads the returned summary -> sees actual content

  const vfs = makeVFS({
    "/inbox/webpage.html": {
      content:
        '<html><body><h1>Hello</h1><p>This is a webpage.</p></body></html>',
      label: networkLabel(),
    },
  });

  // Step 2: Main agent cannot see the webpage
  const mainAgent = new AgentSession({ policy: policies.main(), vfs });
  const step2 = await mainAgent.exec("cat /inbox/webpage.html");
  assertStringIncludes(
    step2.stdout,
    "[FILTERED:",
    "Step 2: Main agent should see FILTERED for network content",
  );
  assertEquals(step2.filtered, true, "Step 2: Should be marked filtered");

  // Step 3-4: Sub-agent can see the webpage
  const sub = mainAgent.spawnSubAgent();
  const step4 = await sub.exec("cat /inbox/webpage.html");
  assertStringIncludes(
    step4.stdout,
    "Hello",
    "Step 4: Sub-agent should see actual webpage content",
  );
  assertEquals(step4.filtered, false, "Step 4: Sub-agent should not filter");

  // Step 5: Sub-agent returns triage summary via return channel
  sub.returnResult("/tmp/triage.txt", "safe: yes");

  // Step 6: Main agent reads returned summary
  const step6 = await mainAgent.exec("cat /tmp/triage.txt");
  assertStringIncludes(
    step6.stdout,
    "safe: yes",
    "Step 6: Main agent should see returned triage summary",
  );
  assertEquals(
    step6.filtered,
    false,
    "Step 6: Returned content should not be filtered",
  );
});

Deno.test("nested sub-agents accumulate taint", async () => {
  // Taint propagates through sub-agent hierarchy.
  // Main -> Sub-A -> Sub-B
  //                    |
  //                    v
  //              reads tainted file, returns result
  //
  // Sub-A sees the result (sub-agent, no requirements)
  // Main sees FILTERED for normal writes
  // Main sees content when Sub-B uses return channel

  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "deeply tainted content",
      label: networkLabel(),
    },
  });

  const mainAgent = new AgentSession({ policy: policies.main(), vfs });
  const subA = mainAgent.spawnSubAgent();
  const subB = subA.spawnSubAgent();

  // Sub-B reads the tainted file and writes a result (normal write)
  await subB.exec("cat /data/tainted.txt");
  await subB.exec('echo "processed result" > /tmp/result.txt');

  // Sub-A can see the result (sub-agent policy allows tainted data)
  const subAResult = await subA.exec("cat /tmp/result.txt");
  assertStringIncludes(
    subAResult.stdout,
    "processed result",
    "Sub-agent A should see sub-agent B's tainted output",
  );
  assertEquals(
    subAResult.filtered,
    false,
    "Sub-agent A should not filter tainted data",
  );

  // Main agent cannot see the tainted result (normal write, no TransformedBy)
  const mainResult = await mainAgent.exec("cat /tmp/result.txt");
  assertStringIncludes(
    mainResult.stdout,
    "[FILTERED:",
    "Main agent should see FILTERED for taint that propagated through hierarchy",
  );

  // Sub-B returns via return channel — makes it visible to main
  subB.returnResult("/tmp/result.txt", "processed result");

  const mainAfterReturn = await mainAgent.exec("cat /tmp/result.txt");
  assertStringIncludes(
    mainAfterReturn.stdout,
    "processed result",
    "Main agent should see content after sub-agent return",
  );
  assertEquals(
    mainAfterReturn.filtered,
    false,
    "Returned data should not be filtered",
  );
});

Deno.test("return channel preserves confidentiality", async () => {
  // Security property: when a sub-agent reads confidential data and returns
  // a result, the returned data inherits the confidentiality of what was read.
  const vfs = makeVFS({
    "/secret/data.txt": {
      content: "secret content",
      label: {
        confidentiality: [[{ kind: "Space", id: "space-123" }]],
        integrity: [],
      },
    },
  });

  const parent = new AgentSession({ policy: policies.main(), vfs });
  const sub = parent.spawnSubAgent();

  // Sub-agent reads confidential data
  await sub.exec("cat /secret/data.txt");

  // Sub-agent returns a result — should carry the confidentiality
  sub.returnResult("/tmp/result.txt", "summary of secret");

  // Check that the returned file has the confidentiality label
  const { label } = sub.shell.vfs.readFileText("/tmp/result.txt");
  assertEquals(
    label.confidentiality.length > 0,
    true,
    "Returned data should inherit confidentiality from read data",
  );
  assertEquals(
    label.integrity.some(a => a.kind === "TransformedBy"),
    true,
    "Returned data should have TransformedBy integrity",
  );
});

Deno.test("!return command via exec", async () => {
  // Test the !return command through the exec interface
  const vfs = makeVFS({
    "/data/input.txt": {
      content: "input data",
      label: networkLabel(),
    },
  });

  const parent = new AgentSession({ policy: policies.main(), vfs });
  const sub = parent.spawnSubAgent();

  await sub.exec("cat /data/input.txt");
  const returnResult = await sub.exec("!return /tmp/output.txt processed data");

  assertStringIncludes(
    returnResult.stdout,
    "TransformedBy",
    "!return should confirm TransformedBy labeling",
  );

  // Parent can now read it
  const parentResult = await parent.exec("cat /tmp/output.txt");
  assertStringIncludes(
    parentResult.stdout,
    "processed data",
    "Parent should see data returned via !return command",
  );
  assertEquals(parentResult.filtered, false);
});
