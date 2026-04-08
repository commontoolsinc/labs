import { env, waitFor } from "@commonfabric/integration";
import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { ShellIntegration } from "../../integration/shell-utils.ts";
import { clickPierce, pierce } from "./shadow-dom.ts";

const { FRONTEND_URL } = env;

// Tests the manual logging in via passphrase.
// Other tests should use the `shell.login(identity)`
// utility to directly provide an identity.
describe("shell login tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can create a new user via passphrase", async () => {
    const page = shell.page();
    const spaceName = "common-knowledge";

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
    });

    const state = await shell.state();
    assert(state);
    assert(
      (state.view as { spaceName: string }).spaceName === "common-knowledge",
    );

    await clickPierce(page, '[test-id="register-new-key"]');
    await pierce(page, '[test-id="generate-passphrase"]');

    await clickPierce(page, '[test-id="generate-passphrase"]');
    await pierce(page, '[test-id="passphrase-continue"]');

    await clickPierce(page, '[test-id="passphrase-continue"]');

    await waitFor(async () => {
      try {
        const handle = await pierce(page, ".header-space", 500);
        const title = await handle.evaluate((el: Element) => el.textContent);
        return title?.trim() === spaceName;
      } catch {
        return false;
      }
    });
  });
});
