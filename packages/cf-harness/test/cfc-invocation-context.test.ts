import { assertEquals } from "@std/assert";
import {
  createHarnessCfcInvocationContext,
  summarizeCfcInvocationSequence,
  summarizeCfcInvocationText,
} from "../src/contracts/cfc-invocation-context.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type { CfcLabelView } from "@commonfabric/runner/cfc";

Deno.test("createHarnessCfcInvocationContext summarizes measured invocation inputs without raw values", async () => {
  // Spec: specs/cfc/18-runtime-implementation-profiles.md §18.2.4.1
  // requires measured execution bundles to bind argv/env/cwd facts. The
  // cf-harness sidecar is provenance transport for those facts; it carries
  // redacted summaries so raw command/input bytes are not copied into the
  // sidecar itself.
  const command = "printf '%s' \"$SECRET_TOKEN\"";
  const argv = ["/bin/printf", "%s", "secret-argv"];
  const args = ["/workspace/secret.txt", "append"];
  const stdinText = "secret stdin payload";
  const env = {
    SECRET_TOKEN: "secret env payload",
    PUBLIC_MODE: "observe",
  };
  const cfcInputLabels: CfcLabelView = {
    version: 1,
    entries: [
      {
        path: ["argv"],
        label: {
          confidentiality: [
            { type: "test.cfc/User", subject: "did:key:argv-reader" },
          ],
        },
      },
      {
        path: ["env", "SECRET_TOKEN"],
        label: {
          confidentiality: [
            { type: "test.cfc/User", subject: "did:key:env-reader" },
          ],
        },
      },
      {
        path: ["cwd"],
        label: {
          confidentiality: [
            { type: "test.cfc/Workspace", subject: "workspace-secret" },
          ],
        },
      },
    ],
  };

  const context = await createHarnessCfcInvocationContext({
    sequence: 7,
    runId: "run-1",
    createdAt: "2026-05-11T16:00:00.000Z",
    toolId: "bash",
    operation: "shell",
    cfcEnforcementMode: "enforce-explicit",
    cwd: "/workspace/project",
    promptSlot: {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      source: { type: "cf-harness.test-input", surface: "cli" },
      role: "direct-command",
      kernelName: "cli",
      surface: "cli",
    },
    runManifest: {
      present: true,
      source: "loom",
      wishId: "W-519",
      cfcEnforcementMode: "enforce-explicit",
      promptSlotPresent: true,
    },
    command,
    argv,
    args,
    stdinText,
    env,
    cfcInputLabels,
  });

  assertEquals(
    context.inputs.command,
    await summarizeCfcInvocationText(command),
  );
  assertEquals(context.inputs.argv, await summarizeCfcInvocationSequence(argv));
  assertEquals(context.inputs.args, await summarizeCfcInvocationSequence(args));
  assertEquals(
    context.inputs.stdin,
    await summarizeCfcInvocationText(stdinText),
  );
  assertEquals(context.inputs.env, {
    type: "cf-harness.env-summary",
    count: 2,
    names: ["PUBLIC_MODE", "SECRET_TOKEN"],
  });
  assertEquals(context.cwd, "/workspace/project");
  assertEquals(context.promptSlot?.type, CFC_PROMPT_SLOT_BOUND_ATOM_TYPE);
  assertEquals(context.cfcInputLabels, cfcInputLabels);

  const serialized = JSON.stringify(context);
  for (
    const rawValue of [
      command,
      "secret-argv",
      stdinText,
      "secret env payload",
    ]
  ) {
    assertEquals(
      serialized.includes(rawValue),
      false,
      `sidecar leaked raw invocation input ${rawValue}`,
    );
  }
});
