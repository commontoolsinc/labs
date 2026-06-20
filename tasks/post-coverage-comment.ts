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
 * No-ops when the file is absent. Keeps a single comment per PR: posts when none
 * exists, otherwise updates the existing one in place. When the payload says
 * coverage is resolved, it rewrites the existing comment into a collapsed
 * summary of where the PR left coverage (and does nothing if there is none).
 * Best-effort: a failure is logged, not fatal, so the workflow stays green.
 *
 * Environment:
 *   GITHUB_TOKEN           - Required.
 *   GITHUB_REPOSITORY      - Optional, defaults to "commontoolsinc/labs".
 *   COVERAGE_COMMENT_FILE  - Optional, path to the payload file.
 */

import {
  buildCoverageResolvedComment,
  COVERAGE_COMMENT_FILE,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
  fetchIssueComments,
  githubPatch,
  githubPost,
  REPO,
  TOKEN,
} from "./perf-lib.ts";

/**
 * Read the pending comment payload and post or update the PR's coverage
 * comment. No-ops when the file is absent. Best-effort: a failure is logged, not
 * thrown, so the workflow stays green.
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

  const { prNumber } = payload;
  // Tolerate older payloads that carried only `body` (no explicit state).
  const state = payload.state ?? (payload.body ? "regressed" : undefined);
  if (typeof prNumber !== "number" || !state) {
    console.error(`Invalid coverage comment payload in ${file}.`);
    return;
  }

  try {
    const existing = await fetchIssueComments(prNumber);
    const marked = existing.find((comment) =>
      comment.body.includes(COVERAGE_SUGGESTION_MARKER)
    );

    if (state === "resolved") {
      if (!marked) {
        console.log(
          `No coverage comment on PR #${prNumber}; nothing to resolve.`,
        );
        return;
      }
      const updated = buildCoverageResolvedComment(
        payload.improvedLines ?? 0,
        payload.groups ?? [],
        payload.overridden ?? false,
      );
      if (updated === marked.body) {
        console.log(
          `Coverage comment on PR #${prNumber} already reflects resolution.`,
        );
        return;
      }
      await githubPatch(`/repos/${REPO}/issues/comments/${marked.id}`, {
        body: updated,
      });
      console.log(`Updated coverage comment on PR #${prNumber} to resolved.`);
      return;
    }

    const { body } = payload;
    if (typeof body !== "string" || !body) {
      console.error(`Invalid coverage comment payload in ${file}.`);
      return;
    }

    if (marked) {
      if (marked.body === body) {
        console.log(
          `Coverage comment on PR #${prNumber} already up to date.`,
        );
        return;
      }
      await githubPatch(`/repos/${REPO}/issues/comments/${marked.id}`, {
        body,
      });
      console.log(`Updated coverage suggestion comment on PR #${prNumber}.`);
      return;
    }

    await githubPost(`/repos/${REPO}/issues/${prNumber}/comments`, { body });
    console.log(`Posted coverage suggestion comment to PR #${prNumber}.`);
  } catch (error) {
    console.warn(
      `  Warning: could not post or update coverage comment on PR #${prNumber}: ${error}`,
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
