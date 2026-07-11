import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type ChurnCounters,
  clickCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "../cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

// The default-ON reload-churn gate (F6c,
// docs/specs/scheduler-v2/per-doc-rehydration.md §7). Per-doc restore
// rehydrates the picker rows instead of re-running them, but the row map
// COORDINATOR deliberately re-runs on resume (resumeMode "always-run", to
// re-attach the rows), and its first reconcile still reads one cold hop
// through the field-level alias chain — measured locally at exactly the same
// coupled 1-conflict residual as the historical rollback-off baseline. The
// bound remains unchanged through the default-on rollout; it drops to ZERO
// when resume-time runners pre-warm their persisted read set (the incremental
// observation-adoption leg). Explicit-false rollback stays covered by the
// runtime and memory protocol suites; this browser suite is default-on only.
//
// This file runs in the `pattern-reload-integration-test` CI job (deno.yml),
// which exercises the default-on configuration and sets
// CF_EXPECT_PERSISTENT_SCHEDULER_STATE=1.

// Keep the dedicated reload job's stable label distinct from the general
// pattern-integration population, even though both now use the default-on flag.
function logChurnMetric(label: string, churn: ChurnCounters): void {
  console.log(
    `CHURN_METRIC label=${label}` +
      ` commitConflicts=${churn.commitConflicts}` +
      ` commitReverts=${churn.commitReverts}` +
      ` scheduleRunErrors=${churn.scheduleRunErrors}` +
      ` commitRejected=${churn.commitRejected}` +
      ` actionRuns=${churn.actionRuns}` +
      ` eventLostRaces=${churn.eventLostRaces}`,
  );
}

// deno-lint-ignore no-explicit-any
async function profileTabHidden(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    const deepFind = (sel: string): Element | null => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const e of root.querySelectorAll("*")) {
          const sr =
            (e as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) stack.push(sr);
        }
      }
      return null;
    };
    const panel = deepFind('cf-tab-panel[value="profile"]') as
      | HTMLElement
      | null;
    return !panel || getComputedStyle(panel).display === "none";
  });
}

// deno-lint-ignore no-explicit-any
async function ensureProfileTabActive(page: any) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

// deno-lint-ignore no-explicit-any
async function createProfile(page: any, name: string) {
  await ensureProfileTabActive(page);
  await waitForRuntimeSynced(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeSynced(page);
}

async function gotoHome(shell: ShellIntegration, identity: Identity) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(shell.page(), 'cf-tab[value="profile"]');
}

describe("home rehydration churn (persistent scheduler state)", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
  });

  it("reloading a populated home stays within one known conflict", async () => {
    const page = shell.page();

    await gotoHome(shell, identity);
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
    await waitForRuntimeSynced(page);

    // Sanity: the create itself runs reactive actions (proves the worker-side
    // counters reflect real activity in this measurement).
    const afterCreate = await collectBrowserLoadSummary(page, "after-create");
    logBrowserLoadSummary(afterCreate);
    logChurnMetric("after-create-persistent", afterCreate.churn);
    expect(afterCreate.churn.actionRuns).toBeGreaterThan(0);

    // RELOAD: re-instantiate the runtime against the populated, durable space.
    await gotoHome(shell, identity);
    await waitForRuntimeIdle(page);
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    const reload = await collectBrowserLoadSummary(page, "reload");
    logBrowserLoadSummary(reload);
    logChurnMetric("reload-persistent", reload.churn);

    const c = reload.churn;
    // Rows rehydrate (no per-row first runs), but the always-run coordinator
    // reconcile keeps the one cold-alias-hop conflict — the same coupled
    // residual accepted by the historical rollback-off baseline. See the
    // header comment; tighten to zero once resume-time runners pre-warm their
    // persisted read sets.
    expect(c.commitConflicts).toBeLessThanOrEqual(1);
    expect(c.commitReverts).toBeLessThanOrEqual(c.commitConflicts);
    expect(c.scheduleRunErrors).toBeLessThanOrEqual(c.commitConflicts);
  });
});
