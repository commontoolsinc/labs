#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Post the coverage-debt suggestion comment produced by the coverage gate.
 *
 * The gate (tasks/perf-check.ts) runs on the `pull_request` event, where fork
 * PRs only get a read-only token and cannot comment. It writes the intended
 * comment to coverage-comment.json and uploads it as an artifact. The
 * `coverage-comment` workflow_run workflow runs this script from the base-repo
 * context with a write token to actually post it.
 *
 * No-ops when the file is absent (no regression). Posts at most once per PR by
 * skipping when a comment carrying the marker already exists. Best-effort: a
 * posting failure is logged, not fatal, so the workflow stays green.
 *
 * Environment:
 *   GITHUB_TOKEN           - Required.
 *   GITHUB_REPOSITORY      - Optional, defaults to "commontoolsinc/labs".
 *   COVERAGE_COMMENT_FILE  - Optional, path to the payload file.
 */

import {
  COVERAGE_COMMENT_FILE,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
  fetchIssueComments,
  githubPost,
  REPO,
  TOKEN,
} from "./perf-lib.ts";

/**
 * Read the pending comment payload and post it, skipping when the file is
 * absent or a marked comment already exists. Best-effort: a posting failure is
 * logged, not thrown, so the workflow stays green.
 */
export async function postCoverageComment(): Promise<void> {
  const file = Deno.env.get("COVERAGE_COMMENT_FILE") ?? COVERAGE_COMMENT_FILE;

  let raw: string;
  try {
    raw = await Deno.readTextFile(file);
  } catch {
    console.log(`No ${file} present; nothing to post.`);
    return;
  }

  let payload: CoverageCommentPayload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error(`Could not parse ${file}: ${error}`);
    return;
  }

  const { prNumber, body } = payload;
  if (typeof prNumber !== "number" || typeof body !== "string" || !body) {
    console.error(`Invalid coverage comment payload in ${file}.`);
    return;
  }

  try {
    const existing = await fetchIssueComments(prNumber);
    if (
      existing.some((comment) =>
        comment.body.includes(COVERAGE_SUGGESTION_MARKER)
      )
    ) {
      console.log(
        `Coverage suggestion comment already present on PR #${prNumber}; not posting again.`,
      );
      return;
    }

    await githubPost(`/repos/${REPO}/issues/${prNumber}/comments`, { body });
    console.log(`Posted coverage suggestion comment to PR #${prNumber}.`);
  } catch (error) {
    console.warn(
      `  Warning: could not post coverage suggestion comment to PR #${prNumber}: ${error}`,
    );
  }
}

if (import.meta.main) {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  await postCoverageComment();
}
