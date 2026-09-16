/** Shares the publisher's current activity between its two dashboard tiles. */

import { REPO, TEST_SELECTION_WORKFLOW } from "./config.ts";
import { github, memo } from "./lib.ts";
import type { Ctx } from "./types.ts";

const readers = new WeakMap<Ctx, () => Promise<boolean | undefined>>();

/** Checks each unfinished status, including reruns of old workflow runs. */
export function publisherRunning(ctx: Ctx): Promise<boolean | undefined> {
  let read = readers.get(ctx);
  if (!read) {
    read = memo(20_000, async () => {
      const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
      if (!token) return undefined;
      const active = await Promise.all(
        ["queued", "in_progress", "waiting", "requested", "pending"].map(
          async (status) => {
            const result = await github<{ workflow_runs: { id: number }[] }>(
              `repos/${REPO}/actions/workflows/${TEST_SELECTION_WORKFLOW}/runs?branch=main&status=${status}&per_page=1`,
              token,
            );
            return result.workflow_runs.length > 0;
          },
        ),
      );
      return active.some(Boolean);
    });
    readers.set(ctx, read);
  }
  return read();
}
