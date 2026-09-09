/** Unit tests for the durable transcript omission record. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { createFileSystemHarnessArtifactStore } from "../src/artifacts.ts";
import {
  annotateHarnessToolResultOmissions,
  createHarnessTranscriptOmissionRuleRecord,
  createHarnessTranscriptOmissions,
  HARNESS_TRANSCRIPT_OMISSION_RULES,
  type HarnessTranscriptOmissionRule,
} from "../src/contracts/transcript-omissions.ts";
import {
  createToolOutputId,
  createToolResultRef,
} from "../src/contracts/tool-result.ts";
import type { HarnessToolTranscriptMessage } from "../src/contracts/transcript.ts";

describe("transcript omissions", () => {
  const runId = "omission-run";
  const outputId = createToolOutputId(runId, "run_pattern", 1);
  const artifactPath = "/artifacts/omission-run/tool-outputs/result.json";
  const resultRef = createToolResultRef(
    outputId,
    "run_pattern",
    runId,
    artifactPath,
  );

  const message = (
    rules: readonly HarnessTranscriptOmissionRule[],
  ): HarnessToolTranscriptMessage =>
    annotateHarnessToolResultOmissions(
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "run_pattern",
        content: JSON.stringify({ status: "ok", value: "model-facing" }),
        resultRef,
      },
      rules.flatMap((rule, index) => {
        const record = createHarnessTranscriptOmissionRuleRecord(
          rule,
          resultRef,
          [`/field-${index}`],
        );
        return record === undefined ? [] : [record];
      }),
    );

  it("records every model-boundary omission rule for its tool result", () => {
    const record = createHarnessTranscriptOmissions([
      { role: "user", content: "Run it." },
      message(HARNESS_TRANSCRIPT_OMISSION_RULES),
    ]);
    expect(record.results).toHaveLength(1);
    expect(record.results[0].transcriptIndex).toBe(1);
    expect(record.results[0].rules.map((entry) => entry.rule)).toEqual(
      HARNESS_TRANSCRIPT_OMISSION_RULES,
    );
    expect(record.results[0].rules[0].locations).toEqual([{
      artifactPath,
      jsonPointer: "/field-0",
    }]);
  });

  it("keeps omission metadata out of serialized provider history", () => {
    const annotated = message(["artifact-only"]);
    expect(JSON.parse(JSON.stringify(annotated))).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "run_pattern",
      content: JSON.stringify({ status: "ok", value: "model-facing" }),
      resultRef,
    });
  });

  it("records a current tool result with no omissions as known empty", () => {
    const record = createHarnessTranscriptOmissions([message([])]);

    expect(record.results).toHaveLength(1);
    expect(record.results[0].rules).toEqual([]);
  });

  it("does not invent a record for an unannotated legacy result", () => {
    const record = createHarnessTranscriptOmissions([{
      role: "tool",
      toolCallId: "legacy-call",
      toolName: "run_pattern",
      content: "legacy model-facing result",
      resultRef,
    }]);

    expect(record.results).toEqual([]);
  });

  it("carries an earlier omission across a replacement tool message", () => {
    const earlier = message(["bare-fabric-identifier-scrub"]);
    const collapse = createHarnessTranscriptOmissionRuleRecord(
      "superseded-run-pattern-diagnostic-collapse",
      resultRef,
      ["/message"],
    )!;
    const replacement = annotateHarnessToolResultOmissions(
      { ...earlier, content: JSON.stringify({ messageCollapsed: true }) },
      [collapse],
      earlier,
    );

    expect(
      createHarnessTranscriptOmissions([replacement]).results[0].rules.map(
        (entry) => entry.rule,
      ),
    ).toEqual([
      "bare-fabric-identifier-scrub",
      "superseded-run-pattern-diagnostic-collapse",
    ]);
  });

  it("writes locations without copying withheld content", async () => {
    const root = await Deno.makeTempDir();
    try {
      const store = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId,
      });
      const raw = {
        outputId,
        status: "ok",
        rawValue: "WITHHELD-SENTINEL",
      };
      const path = await store.persistToolOutput(
        "run_pattern",
        outputId,
        raw,
      );
      const ref = createToolResultRef(
        outputId,
        "run_pattern",
        runId,
        path,
      );
      const omission = createHarnessTranscriptOmissionRuleRecord(
        "artifact-only",
        ref,
        ["/rawValue"],
      )!;
      await store.persistTranscript([
        annotateHarnessToolResultOmissions({
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: JSON.stringify({ outputId, status: "ok" }),
          resultRef: ref,
        }, [omission]),
      ]);

      const recordText = await Deno.readTextFile(
        join(store.runRoot, "transcript-omissions.json"),
      );
      expect(recordText).not.toContain("WITHHELD-SENTINEL");
      expect(JSON.parse(recordText).results[0].rules).toEqual([{
        rule: "artifact-only",
        locations: [{ artifactPath: path, jsonPointer: "/rawValue" }],
      }]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("retains prior-process rules when a later write adds another rule", () => {
    const firstMessage = message(["artifact-only"]);
    const first = createHarnessTranscriptOmissions([firstMessage]);
    const secondMessage = message(["model-context-truncation"]);
    const second = createHarnessTranscriptOmissions([secondMessage], first);
    expect(second.results[0].rules.map((entry) => entry.rule)).toEqual([
      "artifact-only",
      "model-context-truncation",
    ]);
  });

  it("does not overwrite an unsupported prior omission record", async () => {
    const root = await Deno.makeTempDir();
    try {
      const store = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId,
      });
      await Deno.mkdir(store.runRoot, { recursive: true });
      const path = join(store.runRoot, "transcript-omissions.json");
      await Deno.writeTextFile(path, '{"version":999}');

      await expect(store.persistTranscript([message([])])).rejects.toThrow(
        "unsupported transcript omission artifact",
      );
      expect(await Deno.readTextFile(path)).toBe('{"version":999}');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
