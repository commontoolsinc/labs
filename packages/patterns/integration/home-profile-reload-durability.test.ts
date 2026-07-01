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

// Durability of home profile creation across a reload, using ONLY
// `waitForRuntimeIdle` (scheduler quiescence) between steps — never
// `waitForRuntimeSynced` (server confirmation). This mirrors what a user does:
// create a profile, then quickly navigate (reload) or create another, before
// the create's cross-space commit has been confirmed.
//
// A profile create is an event-handler commit that is deliberately not awaited
// (scheduler/events.ts: "Do not await event commits here"), so
// `waitForRuntimeIdle` returns while the commit is still in flight. On
// navigation the shell disposes the outgoing runtime without first awaiting
// pending commits (RootView.ts: `previous.dispose().catch(...)`), violating the
// documented `Runtime.dispose()` contract ("Callers should await all pending
// commits before calling dispose()"), and `storageManager.close()` then tears
// down the in-flight create. So a profile created before the reload is dropped
// from durable storage.
//
// This is a single mechanism — a reload drops whichever create's commit is
// still in flight — and it shows up two ways: the profile created before the
// reload is lost, and (when several are created in quick succession right
// before a reload) the most recent one, whose commit has had the least time to
// confirm, is lost while earlier ones survive.
//
// These tests read durable truth by fully settling AFTER the flow (so each
// surviving profile's own cross-space space loads and its name renders) and
// asserting every created name is present. They fail today; they pass once the
// create is durable across the reload.

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
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  // Only settle the scheduler — leave the cross-space commit in flight.
  await waitForRuntimeIdle(page);
}

// Fully settle so every surviving profile's own space is loaded and its name
// renders. This is the durability read: a lost profile's name never appears
// here, because no space was ever durably created for it.
// deno-lint-ignore no-explicit-any
async function thoroughSettle(page: any) {
  for (let round = 0; round < 6; round++) {
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
  }
}

// deno-lint-ignore no-explicit-any
async function gotoHome(
  shell: ShellIntegration,
  page: any,
  identity: Identity,
) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(page, 'cf-tab[value="profile"]');
}

describe("home profile durability across reload", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identityA: Identity;
  let identityB: Identity;

  beforeAll(async () => {
    identityA = await Identity.generate({ implementation: "noble" });
    identityB = await Identity.generate({ implementation: "noble" });
  });

  it("a profile created before a reload survives the reload", async () => {
    const page = shell.page();

    // Session 1: create a profile; settle only the scheduler, then reload.
    await gotoHome(shell, page, identityA);
    await createProfile(page, "Ada Lovelace");

    // Reload (new session on the same home space).
    await gotoHome(shell, page, identityA);
    await thoroughSettle(page);

    // The profile created before the reload must still be present.
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
  });

  it("the most recent of several rapid creates survives a following reload", async () => {
    const page = shell.page();

    // Create two profiles in quick succession (only scheduler settles between),
    // then reload immediately — the second create's commit is still in flight.
    await gotoHome(shell, page, identityB);
    await createProfile(page, "Grace Hopper");
    await createProfile(page, "Alan Turing");

    // Reload, then settle so surviving profiles render.
    await gotoHome(shell, page, identityB);
    await thoroughSettle(page);

    // Both must be durably present; today the trailing one ("Alan Turing") is
    // lost because its commit had the least time to confirm before the reload.
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForText(page, "#home-profile-summary", "Alan Turing");
  });
});
