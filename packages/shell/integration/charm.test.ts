import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import "../src/globals.ts";

const { API_URL, FRONTEND_URL } = env;

describe("shell charm tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can view and interact with a charm", async () => {
    const { page, identity } = shell.get();
    const spaceName = globalThis.crypto.randomUUID();

    const charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "..",
          "..",
          "recipes",
          "counter.tsx",
        ),
      ),
    });

    // TODO(js): Remove /shell when no longer prefixed
    await page.goto(`${FRONTEND_URL}shell/${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);
    assertEquals(
      state.identity?.serialize().privateKey,
      identity.serialize().privateKey,
    );

    await sleep(2000);
    let handle = await page.$(
      "ct-button",
      { strategy: "pierce" },
    );
    assert(handle);
    handle.click();
    await sleep(1000);
    handle.click();
    await sleep(1000);
    handle = await page.$(
      "#counter-result",
      { strategy: "pierce" },
    );
    await sleep(2000);
    const text = await handle?.innerText();
    assert(text === "Counter is the -2th number");
  });
});
