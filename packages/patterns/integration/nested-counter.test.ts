import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { getCharmResult, setCharmResult } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL } = env;

describe("counter direct operations test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let spaceName: string;
  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();
    spaceName = globalThis.crypto.randomUUID();

    // Register the counter charm
    charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "double-counter.tsx",
        ),
      ),
    });

    // Setup the CharmManager for direct operations
    await shell.setupManager(spaceName, API_URL);
  });

  it("should load the double counter charm and verify initial state", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and verify counter exists
    await sleep(5000);
    const counterResult = await page.$("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element");

    // Verify initial value is 0
    const initialText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(initialText?.trim(), "Counter is the 0th number");

    // Also verify via direct operations
    const manager = shell.manager!;
    const value = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(value, 0);
  });

  it("should click the increment button and change both values", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and verify counter exists
    await sleep(5000);
    const buttonResult = await page.$("[data-ct-button]", {
      strategy: "pierce",
    });
    assert(buttonResult, "Should find a button element");
    await buttonResult.click();

    await sleep(1000);

    const counterResult = await page.$("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element");
    const counterText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(counterText?.trim(), "Counter is the -1th number");

    await sleep(1000);

    // Also verify via direct operations
    const manager = shell.manager!;
    const value = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(value, -1);
  });
});
