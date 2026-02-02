/**
 * Agent System Tests
 *
 * Tests the agent protocol's visibility filtering, sub-agent spawning,
 * endorsement, and label tracking.
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
  // Security property: user-input data carries InjectionFree, so the main
  // agent policy (which requires InjectionFree) should allow it through.
  const label = userLabel();
  const result = checkVisibility(label, policies.main());
  assertEquals(result, null, "User input should satisfy main policy");
});

Deno.test("checkVisibility returns reason for data violating policy", () => {
  // Security property: network-fetched data lacks InjectionFree, so the main
  // agent policy should reject it with a reason string explaining why.
  const label = networkLabel();
  const result = checkVisibility(label, policies.main());
  assertEquals(
    typeof result,
    "string",
    "Network data should fail main policy check",
  );
  assertStringIncludes(
    result!,
    "InjectionFree",
    "Reason should mention the missing atom",
  );
});

Deno.test("checkVisibility allows everything for empty requirements", () => {
  // Security property: a sub-agent policy with no integrity requirements
  // can see all data regardless of its labels.
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

Deno.test("filterOutput passes through visible data", () => {
  // Security property: data that satisfies the policy should be returned
  // unchanged, with filtered=false.
  const content = "trusted user input data";
  const result = filterOutput(content, userLabel(), policies.main());
  assertEquals(result.content, content, "Content should be unchanged");
  assertEquals(result.filtered, false, "filtered flag should be false");
});

Deno.test("filterOutput redacts invisible data", () => {
  // Security property: data that fails the policy check should be replaced
  // with a [FILTERED:...] marker so the main agent never sees raw untrusted content.
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
  // Security property: files written with userInput label (which has
  // InjectionFree) are visible to the main agent.
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
    // Security property: files from the network lack InjectionFree, so the main
    // agent should see a [FILTERED] placeholder instead of the raw content.
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
  // Security property: sub-agents have relaxed policies (no InjectionFree
  // requirement) so they can process untrusted content on behalf of the
  // main agent.
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

Deno.test("sub-agent can endorse file", async () => {
  // Security property: after a sub-agent reviews untrusted content, it can
  // add InjectionFree integrity, making the data visible to the parent.
  const vfs = makeVFS({
    "/data/reviewed.txt": {
      content: "reviewed safe content",
      label: networkLabel(),
    },
  });
  const parent = new AgentSession({ policy: policies.main(), vfs });
  const sub = parent.spawnSubAgent();

  // Sub-agent endorses the file with InjectionFree
  await sub.endorseFile("/data/reviewed.txt", { kind: "InjectionFree" });

  // Now the parent should be able to see it
  const result = await parent.exec("cat /data/reviewed.txt");
  assertStringIncludes(
    result.stdout,
    "reviewed safe content",
    "Parent should see endorsed content",
  );
  assertEquals(result.filtered, false, "Endorsed data should not be filtered");
});

Deno.test("main agent cannot endorse", async () => {
  // Security property: the main agent must not be able to bypass its own
  // visibility restrictions by self-endorsing. Only sub-agents can endorse.
  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "tainted content",
      label: networkLabel(),
    },
  });
  const agent = new AgentSession({ policy: policies.main(), vfs });

  let errorThrown = false;
  try {
    await agent.endorseFile("/data/tainted.txt", { kind: "InjectionFree" });
  } catch (_e) {
    errorThrown = true;
  }
  assertEquals(
    errorThrown,
    true,
    "Main agent should not be allowed to endorse files",
  );
});

Deno.test("readFile filters based on policy", async () => {
  // Security property: readFile returns a filtered flag that matches the
  // agent's policy -- main agent gets filtered=true for tainted data,
  // sub-agent gets filtered=false.
  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "tainted data",
      label: networkLabel(),
    },
  });

  const mainAgent = new AgentSession({ policy: policies.main(), vfs });
  const mainResult = await mainAgent.readFile("/data/tainted.txt");
  assertEquals(
    mainResult.filtered,
    true,
    "Main agent readFile should report filtered=true for tainted data",
  );

  const sub = mainAgent.spawnSubAgent();
  const subResult = await sub.readFile("/data/tainted.txt");
  assertEquals(
    subResult.filtered,
    false,
    "Sub-agent readFile should report filtered=false for same data",
  );
});

Deno.test("label inspect shows label info", async () => {
  // Security property: the !label command lets agents introspect the
  // integrity atoms on a file without necessarily seeing its content.
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
  // Security property: parent and child share the same VFS so the child
  // can read files the parent wrote, enabling delegation of work.
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
    // Security property: when a sub-agent writes a file, the parent can see it
    // but the content may be filtered if the sub-agent's output carries taint
    // from reading untrusted data.
    const vfs = makeVFS({
      "/data/untrusted.txt": {
        content: "untrusted content",
        label: networkLabel(),
      },
    });
    const parent = new AgentSession({ policy: policies.main(), vfs });
    const sub = parent.spawnSubAgent();

    // Sub-agent reads tainted data and writes a summary.
    // The output inherits taint from the input (no InjectionFree).
    await sub.exec("cat /data/untrusted.txt");
    await sub.exec('echo "summary of untrusted" > /tmp/summary.txt');

    // Parent tries to read the sub-agent's output -- should be filtered
    // because the sub-agent's write carries taint from reading the untrusted file.
    const parentResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      parentResult.stdout,
      "[FILTERED:",
      "Parent should see FILTERED marker for tainted sub-agent output",
    );
  },
);

Deno.test(
  "sub-agent endorsement makes data visible to parent",
  async () => {
    // Security property: the full endorsement flow -- sub-agent processes
    // untrusted data, writes a clean summary, and endorses it so the parent
    // can read it.
    const vfs = makeVFS({
      "/inbox/email.html": {
        content: "<p>meeting at 3pm</p>",
        label: networkLabel(),
      },
    });
    const parent = new AgentSession({ policy: policies.main(), vfs });
    const sub = parent.spawnSubAgent();

    // Sub-agent reads, processes, writes summary
    await sub.exec("cat /inbox/email.html");
    await sub.exec('echo "Meeting at 3pm" > /tmp/summary.txt');

    // Before endorsement, parent cannot see it
    const beforeResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      beforeResult.stdout,
      "[FILTERED:",
      "Before endorsement, parent should see FILTERED",
    );

    // Sub-agent endorses
    await sub.endorseFile("/tmp/summary.txt", { kind: "InjectionFree" });

    // After endorsement, parent can see it
    const afterResult = await parent.exec("cat /tmp/summary.txt");
    assertStringIncludes(
      afterResult.stdout,
      "Meeting at 3pm",
      "After endorsement, parent should see actual content",
    );
    assertEquals(
      afterResult.filtered,
      false,
      "After endorsement, filtered should be false",
    );
  },
);

// ============================================================================
// CLI Tests
// ============================================================================

Deno.test("CLI processLine executes commands", async () => {
  // Basic CLI functionality: commands produce output.
  // The main agent requires InjectionFree integrity, so echo output
  // (which carries bottom label with no integrity atoms) is filtered.
  // Use a sub-agent policy to see raw output.
  const cli = new AgentCLI({ policy: policies.sub() });
  const output = await cli.processLine("echo hello");
  assertStringIncludes(output, "hello", "CLI should execute echo command");
});

Deno.test("CLI processLine handles !sub and !end", async () => {
  // CLI meta-commands: !sub pushes a sub-agent onto the stack,
  // !end pops back to the parent.
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
  // The !policy command shows the current agent's policy configuration.
  const cli = new AgentCLI({});
  const output = await cli.processLine("!policy");
  assertStringIncludes(
    output,
    "InjectionFree",
    "!policy should show the main policy requirements",
  );
});

Deno.test("CLI processLine filters tainted data", async () => {
  // Security property: the CLI layer applies the same filtering as the
  // underlying AgentSession -- tainted file content is replaced with [FILTERED].
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

Deno.test("full agent workflow: triage untrusted content", async () => {
  // End-to-end scenario:
  // 1. A webpage is fetched from the network (carries NetworkProvenance, no InjectionFree)
  // 2. Main agent tries to read it -> gets FILTERED
  // 3. Main agent spawns sub-agent
  // 4. Sub-agent reads the webpage -> sees actual content
  // 5. Sub-agent writes a triage summary
  // 6. Sub-agent endorses the summary with InjectionFree
  // 7. Main agent reads the endorsed summary -> sees actual content

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

  // Step 5: Sub-agent writes triage summary
  await sub.exec('echo "safe: yes" > /tmp/triage.txt');

  // Step 6: Sub-agent endorses the summary
  await sub.endorseFile("/tmp/triage.txt", { kind: "InjectionFree" });

  // Step 7: Main agent reads endorsed summary
  const step7 = await mainAgent.exec("cat /tmp/triage.txt");
  assertStringIncludes(
    step7.stdout,
    "safe: yes",
    "Step 7: Main agent should see endorsed triage summary",
  );
  assertEquals(
    step7.filtered,
    false,
    "Step 7: Endorsed content should not be filtered",
  );
});

Deno.test("nested sub-agents accumulate taint", async () => {
  // Security property: taint propagates through the sub-agent hierarchy.
  // When sub-agent B reads tainted data and writes a result, the taint
  // flows through even if sub-agent A is in the middle of the chain.
  //
  // Main -> Sub-A -> Sub-B
  //                    |
  //                    v
  //              reads tainted file
  //              writes result (carries taint)
  //
  // Sub-A sees the result (sub-agent, no InjectionFree requirement)
  // Main sees FILTERED (main agent, requires InjectionFree)

  const vfs = makeVFS({
    "/data/tainted.txt": {
      content: "deeply tainted content",
      label: networkLabel(),
    },
  });

  const mainAgent = new AgentSession({ policy: policies.main(), vfs });
  const subA = mainAgent.spawnSubAgent();
  const subB = subA.spawnSubAgent();

  // Sub-B reads the tainted file and writes a result
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

  // Main agent cannot see the tainted result
  const mainResult = await mainAgent.exec("cat /tmp/result.txt");
  assertStringIncludes(
    mainResult.stdout,
    "[FILTERED:",
    "Main agent should see FILTERED for taint that propagated through hierarchy",
  );
  assertEquals(
    mainResult.filtered,
    true,
    "Main agent should filter tainted data from nested sub-agents",
  );

  // Sub-B endorses, making it visible to main
  await subB.endorseFile("/tmp/result.txt", { kind: "InjectionFree" });

  const mainAfterEndorse = await mainAgent.exec("cat /tmp/result.txt");
  assertStringIncludes(
    mainAfterEndorse.stdout,
    "processed result",
    "Main agent should see content after nested sub-agent endorsement",
  );
  assertEquals(
    mainAfterEndorse.filtered,
    false,
    "Endorsed data should not be filtered",
  );
});
