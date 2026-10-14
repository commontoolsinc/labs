/**
 * Scores task classification over the 2026-10-13 playtest asks two ways: the
 * keyword rule alone, and the cheap-model path alone, asked of every case
 * whether or not the rule had an answer. Prints each case and the accuracy and
 * latency of both paths.
 *
 * The model path makes one live call per case on the owner's Codex
 * credential from the harness home, so it is run by hand, never in CI:
 *
 *   deno run -A packages/cf-harness/scripts/task-classification-eval.ts \
 *     [--harness-home ~/.cf-harness] [--owner local] [--rule-only]
 */
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

import {
  defaultHarnessCredentialStorePath,
  FileHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import { OpenAICodexCredentialResolver } from "../src/auth/openai-codex.ts";
import {
  recordUndeclaredFlags,
  refuseFlagsWithoutValue,
  refuseUndeclaredFlags,
} from "../src/cli-flags.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { researchModel } from "../src/research/runner.ts";
import {
  classifyTaskByModel,
  classifyTaskByRule,
  type HarnessTaskTag,
} from "../src/task-classification.ts";
import { PLAYTEST_2026_10_13_TASKS } from "../test/task-classification-cases.ts";

const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: ["harness-home", "owner"],
  boolean: ["rule-only"],
  unknown: recordUndeclaredFlags(undeclared),
});
// Before any call: a misspelled `--harness-home` would otherwise score
// against the default credential store.
try {
  refuseFlagsWithoutValue(Deno.args, ["harness-home", "owner"]);
  refuseUndeclaredFlags(
    undeclared,
    ["harness-home", "owner", "rule-only"],
    "`task-classification-eval`",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(2);
}
const harnessHome = args["harness-home"] ??
  join(Deno.env.get("HOME") ?? ".", ".cf-harness");
const ownerKey = args.owner ?? "local";

const label = (tags: ReadonlySet<HarnessTaskTag> | undefined) =>
  tags === undefined ? "(none)" : [...tags].sort().join(",");

const credentialOwner = {
  type: "cf-harness.credential-owner-ref",
  version: 1,
  ownerKey,
} as const;
const client = args["rule-only"] ? undefined : new OpenAICodexResponsesClient({
  credentialResolver: new OpenAICodexCredentialResolver({
    store: new FileHarnessCredentialStore({
      path: defaultHarnessCredentialStorePath(harnessHome),
    }),
    ownerKey,
    credentialOwner,
  }),
  credentialOwner,
});
const askModel = client === undefined
  ? undefined
  : async (prompt: string) =>
    (await client.complete({
      model: researchModel(client.providerId),
      transcript: [{ role: "user", content: prompt }],
      tools: [],
      nativeModelToolIds: [],
      runId: "task-classification-eval",
    })).assistant.content;

let ruleCorrect = 0;
let modelCorrect = 0;
let ruleMs = 0;
const modelMs: number[] = [];
for (const { task, context, expected } of PLAYTEST_2026_10_13_TASKS) {
  const want = label(new Set(expected));
  const ruleStarted = performance.now();
  const byRule = label(classifyTaskByRule(task, context));
  ruleMs += performance.now() - ruleStarted;
  if (byRule === want) ruleCorrect += 1;
  let byModel = "-";
  if (askModel !== undefined) {
    const modelStarted = performance.now();
    try {
      byModel = label(await classifyTaskByModel(task, context, askModel));
    } catch (error) {
      byModel = `error: ${error instanceof Error ? error.message : error}`;
    }
    modelMs.push(performance.now() - modelStarted);
    if (byModel === want) modelCorrect += 1;
  }
  console.log(
    [JSON.stringify(task), `want ${want}`, `rule ${byRule}`, `model ${byModel}`]
      .join(" | "),
  );
}

const total = PLAYTEST_2026_10_13_TASKS.length;
console.log(
  `rule: ${ruleCorrect}/${total} exact, ${ruleMs.toFixed(2)} ms for the set`,
);
if (modelMs.length > 0) {
  const sorted = [...modelMs].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
      .toFixed(0);
  console.log(
    `model (${
      researchModel(client!.providerId)
    }): ${modelCorrect}/${total} exact, latency p50 ${at(0.5)} ms, p90 ${
      at(0.9)
    } ms, max ${sorted.at(-1)!.toFixed(0)} ms`,
  );
}
