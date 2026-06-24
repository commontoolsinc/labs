import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  clickCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

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

// Like createProfile but settles only with `waitForRuntimeIdle` (no
// `waitForRuntimeSynced`): a create issued while the post-reload rehydration
// window is still settling.
// deno-lint-ignore no-explicit-any
async function createProfileRacy(page: any, name: string) {
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

async function gotoHome(shell: ShellIntegration, identity: Identity) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(shell.page(), 'cf-tab[value="profile"]');
}

// Reload health for the home space. Re-instantiating the runtime against a
// populated, already-durable home is read-mostly. This guard asserts two
// observable properties:
//   1. Reloading re-commits ~nothing already-durable: commit conflicts,
//      reverts, and schedule-run-errors stay near zero, bounded rather than
//      scaling with accumulated history.
//   2. A profile created in the post-reload window (settling only on idle)
//      survives a subsequent clean reload, which renders from durable state.
describe("home rehydration", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
  });

  it("reloading a populated home re-commits ~nothing already-durable", async () => {
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
    expect(afterCreate.churn.actionRuns).toBeGreaterThan(0);

    // RELOAD: re-instantiate the runtime against the populated, durable space.
    await gotoHome(shell, identity);
    await waitForRuntimeIdle(page);
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    const reload = await collectBrowserLoadSummary(page, "reload");
    logBrowserLoadSummary(reload);

    const c = reload.churn;
    // Read-mostly reload: re-commits stay bounded rather than scaling into a
    // storm. The exact count is timing- and hardware-sensitive (it is logged
    // above for observability), so the bound is generous; the durability test
    // below is the precise correctness gate.
    expect(c.commitConflicts).toBeLessThanOrEqual(20);
    expect(c.commitReverts).toBeLessThanOrEqual(20);
    expect(c.scheduleRunErrors).toBeLessThanOrEqual(20);
  });

  it("a profile created in the post-reload window is durable", async () => {
    const page = shell.page();
    const id = await Identity.generate({ implementation: "noble" });

    await gotoHome(shell, id);
    await createProfile(page, "Grace Hopper");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForRuntimeSynced(page);

    await gotoHome(shell, id);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    // Create immediately after reload, settling only on idle — within the
    // post-reload rehydration window.
    await createProfileRacy(page, "Katherine Johnson");
    await waitForRuntimeSynced(page);

    // Final clean reload renders from durable state. Both must survive.
    await gotoHome(shell, id);
    await waitForRuntimeIdle(page);
    await waitForRuntimeSynced(page);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForText(page, "#home-profile-summary", "Katherine Johnson");
  });
});
