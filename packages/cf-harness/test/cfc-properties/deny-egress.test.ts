/**
 * P-deny-egress and P-allow: a label decides an outcome, in both directions.
 *
 * One pattern, one seeded document, two episodes. The refused episode passes
 * the pattern a reference derived from a `Confidential` field, so its answer
 * carries the label and the answer sink's ceiling refuses to release it. The
 * permitted episode drops exactly that input and nothing else, so the same
 * pattern's answer releases.
 *
 * Running both is the point. A suite that only proves refusals cannot tell a
 * working gate from one that refuses everything, and AUD-16 counting a refusal
 * means nothing unless a run that should not be refused is not.
 *
 * The assertions are the audit's verdicts over the artifacts these episodes
 * write, not hand-read JSON. What the refusal itself contains is pinned in
 * `test/run-pattern.test.ts`, which owns the tool's contract; what is pinned
 * here is that the refusal reaches an artifact and that a check can see it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { RunPatternToolSuccessOutput } from "../../src/tools/run-pattern.ts";

import {
  auditArtifacts,
  createLabeledFabric,
  directPromptSlotBinding,
  InertSandboxRuntime,
  messagesOf,
  OPTIONAL_SECRET_PATTERN_SOURCE,
  scriptedModel,
  seedLabeledSecret,
  TOTAL_RESULT_SCHEMA,
} from "./support/episode.ts";

/** The seeded secret, which no model-visible text may carry. */
const SECRET = "s3cr3t";

interface EpisodeOutcome {
  artifactRoot: string;
  runId: string;
  /** Every model-facing message of the run, joined, for a disclosure check. */
  modelVisibleText: string;
  output: RunPatternToolSuccessOutput;
}

/**
 * Runs one `run_pattern` episode end to end and answers what it wrote.
 *
 * `withSource` is the only difference between the two properties: it decides
 * whether the labeled reference reaches the pattern's inputs.
 */
const runEpisode = async (
  options: { withSource: boolean },
): Promise<EpisodeOutcome> => {
  const fabric = await createLabeledFabric("enforce-explicit");
  const artifactRoot = await Deno.makeTempDir({ prefix: "cfc-property-" });
  const runId = `deny-egress-${options.withSource ? "refused" : "allowed"}`;
  try {
    const sourceRef = await seedLabeledSecret(
      fabric.runtime,
      fabric.space,
      runId,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new InertSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "enforce-explicit",
      // The factory supplies the emulated session; the config beside it names
      // the space, which is what the run-end cell-labels read needs to know
      // which space to ask about. Without it the run retains no record of
      // having asked, and AUD-9 reads that as evidence not kept.
      fabricSession: {
        apiUrl: "http://toolshed.test",
        identityKeyPath: "/keys/unused.pkcs8",
        space: String(fabric.space),
      },
      fabricSessionFactory: () => Promise.resolve({ pieces: fabric.pieces }),
      artifactStore: new FileSystemHarnessArtifactStore({
        artifactRoot,
        runId,
      }),
    });
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedModel([{
        toolName: "run_pattern",
        arguments: {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs: options.withSource
            ? { amount: 2, source: sourceRef }
            : { amount: 2 },
          resultSchema: TOTAL_RESULT_SCHEMA,
        },
      }]),
    });

    const result = await loop.runPrompt({
      prompt: "Total the amount.",
      promptSlotBinding: directPromptSlotBinding,
    });
    await engine.persistRunState();

    const toolMessage = result.transcript.find((message) =>
      message.role === "tool" && message.toolName === "run_pattern"
    );
    expect(toolMessage).toBeDefined();
    return {
      artifactRoot,
      runId,
      modelVisibleText: result.transcript.map((message) => message.content)
        .join("\n"),
      output: JSON.parse(toolMessage!.content) as RunPatternToolSuccessOutput,
    };
  } finally {
    await fabric.dispose();
  }
};

describe("cfc property: egress of a labeled flow", () => {
  describe("P-deny-egress — a ceilinged sink refuses a labeled answer", () => {
    it("records a policyRefusal artifact that AUD-16 counts as a release refusal", async () => {
      const episode = await runEpisode({ withSource: true });

      // The refusal happened, and it is a refusal a label decided rather than
      // one authority decided: the run succeeded and withheld its values.
      expect(episode.output.status).toBe("ok");
      expect(episode.output.value).toBeUndefined();
      expect(episode.output.policyRefusal?.gates).toEqual(["sink-ceiling"]);

      // The checker is the assertion library. AUD-16 counts the artifact
      // channel, so a refusal the transcript shows but no artifact records
      // fails here.
      const audit = await auditArtifacts(episode.artifactRoot, {
        expectRefusals: true,
      });
      const aud16 = audit.findings("AUD-16");
      expect(aud16).toHaveLength(1);
      expect(aud16[0].verdict).not.toBe("fail");
      expect(aud16[0].message).toContain("1 release refusal");
      expect(aud16[0].message).toContain("sink-ceiling");
    });

    it("keeps the labeled payload out of every model-visible message", async () => {
      // AH-CFC-11: the refusal reaches the model through the typed channel,
      // carrying what was refused and not what it withheld.
      const episode = await runEpisode({ withSource: true });

      expect(episode.modelVisibleText).not.toContain(SECRET);
      expect(episode.output.valueError).toContain("policy refused to release");
    });
  });

  describe("P-allow — the same flow without the labeled input", () => {
    it("releases the answer", async () => {
      // The guard against a gate that refuses everything: one input dropped,
      // nothing else changed, and the value comes back.
      const episode = await runEpisode({ withSource: false });

      expect(episode.output.status).toBe("ok");
      expect(episode.output.policyRefusal).toBeUndefined();
      expect(episode.output.value).toEqual({ total: 2 });
    });

    it("fails only the two checks a permitted run is known to fail", async () => {
      // The guard against the audit becoming an always-fails alarm, and the
      // record of what a clean run does fail today.
      //
      // Both failures are findings about the harness, not about this episode,
      // and both are invisible to the historic corpus:
      //
      // AUD-3 — `run_pattern` persists a `run-pattern-source` artifact into
      // `tool-outputs/` that the run report's `toolOutputs` never lists, so
      // every fresh run with inline source trips "a tool output on disk the
      // run report does not list". The corpus holds 534 `run_pattern` outputs
      // and no source artifact: it was added after those runs were recorded,
      // and no run has been audited with one since.
      //
      // AUD-9 — an executed side effect wants a CFC invocation context, and
      // `run_pattern` reaches the fabric rather than the sandbox, so no
      // context is ever recorded for it.
      //
      // Asserting the exact set rather than a ceiling: this fails if another
      // check starts firing, and equally if either of these is fixed, so the
      // list cannot quietly rot into a permanent excuse.
      const episode = await runEpisode({ withSource: false });

      const audit = await auditArtifacts(episode.artifactRoot);
      const failing = audit.results.filter((result) =>
        result.verdict === "fail"
      );
      expect(failing.map((result) => result.checkId).sort()).toEqual([
        "AUD-3",
        "AUD-9",
      ]);
      expect(messagesOf(failing)).toContain("run-pattern-source");
      expect(messagesOf(failing)).toContain("CFC invocation context");
    });
  });
});
