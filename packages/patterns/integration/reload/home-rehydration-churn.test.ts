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

// The flag-ON reload-churn gate (F6c acceptance,
// docs/specs/scheduler-v2/per-doc-rehydration.md §7). The flag-OFF variant
// (../home-rehydration-churn.test.ts) accepts ONE self-healing conflict: the
// profile picker's row map runs fresh on reload and its first run reads
// through field-level alias chains into a cold document. Under persistent
// scheduler state the rows REHYDRATE per piece doc instead of re-running, so
// that first run — and its conflict — must not exist: the bound is ZERO.
//
// This file runs in the `pattern-reload-integration-test` CI job (deno.yml),
// which builds the shell with EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true
// and sets CF_EXPECT_PERSISTENT_SCHEDULER_STATE=1. When the expectation env
// is absent (running the reload dir ad hoc against a flag-off shell) the gate
// falls back to the flag-off residual bound so the test stays meaningful.
const EXPECT_PERSISTENT_SCHEDULER_STATE = (() => {
  const raw = Deno.env.get("CF_EXPECT_PERSISTENT_SCHEDULER_STATE");
  return raw === "1" || raw === "true" || raw === "yes";
})();

// Same stable, greppable measurement contract as the flag-off variant, under
// a distinct label so CI-distribution greps do not mix the two populations.
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

  it("reloading a populated home commits no conflicts at all", async () => {
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
    // Per-doc rehydration restores each picker row's persisted scheduler
    // state instead of re-running it, so the flag-off world's one accepted
    // cold-alias-hop conflict has no first run to ride on: ZERO conflicts.
    // Reverts and run-errors stay coupled to the conflict count, so at zero
    // conflicts they are zero too.
    const conflictBound = EXPECT_PERSISTENT_SCHEDULER_STATE ? 0 : 1;
    expect(c.commitConflicts).toBeLessThanOrEqual(conflictBound);
    expect(c.commitReverts).toBeLessThanOrEqual(c.commitConflicts);
    expect(c.scheduleRunErrors).toBeLessThanOrEqual(c.commitConflicts);
  });
});
