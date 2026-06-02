import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

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
    await fillCfInput(page, "#wish-profile-picker-name-input", "Ada Lovelace");
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
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
    await fillCfInput(page, "#wish-profile-picker-name-input", "Ada Lovelace");
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    // Second profile — must append, not overwrite.
    await fillCfInput(page, "#wish-profile-picker-name-input", "Alan Turing");
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);

    // Both profiles are now listed in the picker.
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
  });
});
