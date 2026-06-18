import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

// Workaround for a flaky activeTab regression (tracked in Linear CT-1666):
// navigating to the home view with profile data already persisted sometimes
// resets the active tab from "profile" back to its "spaces" default. That hides
// the whole `profile` tab-panel (`display:none`), so the profile picker + its
// create surface collapse to 0×0 and the trusted "Create profile" click times
// out — even though the picker rendered correctly. Until the activeTab
// rehydration race is fixed, defensively re-activate the profile tab (up to 5×,
// warning each time) before touching the create surface.
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
  // Settle FIRST so a late activeTab revert has time to land, THEN probe; if the
  // profile tab fell back to its default, re-activate it (up to 5×, warning).
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    console.warn(
      `[home-profile] activeTab fell back off "profile" (picker hidden); ` +
        `re-activating profile tab (attempt ${attempt}/5)`,
    );
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

// deno-lint-ignore no-explicit-any
async function createProfile(page: any, name: string) {
  await ensureProfileTabActive(page);
  // Each profile lives in its own `inSpace` child space, so appending one is a
  // cross-space commit. `waitForRuntimeIdle` returns once the scheduler queue
  // drains; `waitForRuntimeSynced` additionally awaits every opened space to
  // reconcile. Settle fully before submitting so the append does not interleave
  // with commits still in flight from a prior navigation's rehydration, and
  // again after so it reconciles before the caller navigates or appends again.
  await waitForRuntimeSynced(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeSynced(page);
}

// Regression coverage for creating a profile directly from the home space's
// Profile tab (the `{ builtin: "home" }` root view). The existing
// shared-profile test only exercises creation through the `#profile` wish UI
// rendered by a *piece*; that path passes the profile cell as a schema-less
// link, so it never hit the bug. Creating from home rendered ProfileCreate with
// the owner-protected (IFC) profile cell, which materialized the cross-space
// `inSpace` child during the handler's own `.set()` and tripped the
// single-space write-isolation guard ("cross-space writes" error) — so the
// profile was never created and the form stayed put.
describe("home-space profile creation", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
  });

  it("creates a profile from the home Profile tab without a cross-space write error", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    // Open the Profile tab and create a profile through the picker's inline
    // create surface (the trusted create action). The home Profile tab is the
    // profile picker.
    await clickCfButton(page, 'cf-tab[value="profile"]');
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);

    // The new profile is appended to the home `profiles` list and rendered in
    // the picker. This exercises the cross-space `inSpace` append as an array
    // element (the #3812 multi-space-commit path applied to a push, not a set).
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
  });

  it("creates a second profile from the picker (multi-profile append)", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });

    await clickCfButton(page, 'cf-tab[value="profile"]');

    // First profile.
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    // Second profile — must append, not overwrite.
    await createProfile(page, "Alan Turing");
    await waitForRuntimeIdle(page);

    // Both profiles are now listed in the picker.
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
  });
});
