import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle, waitForText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const SHARED_PROFILE_TIMEOUT = 30_000;

describe("shared profile integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let sharedSpaceDid: string;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    sharedSpaceDid = cc.manager().getSpace();

    const demoSource = await Deno.readTextFile(
      join(
        import.meta.dirname!,
        "..",
        "shared-profile-demo",
        "main.tsx",
      ),
    );
    const piece = await cc.create(
      `${demoSource}\n// integration instance ${crypto.randomUUID()}\n`,
      { start: true },
    );
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("uses each user's home profile when rendering a shared pattern", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
      identity,
    });
    await waitForRuntimeIdle(page);
    await waitForText(page, "#shared-profile-name", "No profile");

    await createHomeProfile(shell, page, identity, "Ada Lovelace");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
      identity,
    });
    await waitForRuntimeIdle(page);
    await waitForText(page, "#shared-profile-name", "Ada Lovelace");

    await shell.login(secondIdentity);
    await shell.waitForState({
      identity: secondIdentity,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
    });
    await waitForRuntimeIdle(page);
    await waitForText(page, "#shared-profile-name", "No profile");

    await createHomeProfile(shell, page, secondIdentity, "Grace Hopper");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
      identity: secondIdentity,
    });
    await waitForRuntimeIdle(page);
    await waitForText(page, "#shared-profile-name", "Grace Hopper");
  });
});

async function createHomeProfile(
  shell: ShellIntegration,
  page: Page,
  identity: Identity,
  name: string,
) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await waitForRuntimeIdle(page);
  await clickCfTab(page, "profile");
  await sendMessageInput(page, "#home-profile-name-input", name);
  await waitForRuntimeIdle(page);
  await waitForText(page, "#home-profile-summary", name);
}

async function clickCfTab(page: Page, value: string) {
  const tab = await page.waitForSelector(`cf-tab[value="${value}"]`, {
    strategy: "pierce",
    timeout: SHARED_PROFILE_TIMEOUT,
  });
  await tab.click();
}

async function sendMessageInput(page: Page, selector: string, message: string) {
  const host = await page.waitForSelector(selector, {
    strategy: "pierce",
    timeout: SHARED_PROFILE_TIMEOUT,
  });
  await host.evaluate((element: Element, value: string) => {
    element.dispatchEvent(
      new CustomEvent("cf-send", {
        bubbles: true,
        composed: true,
        detail: { message: value },
      }),
    );
  }, { args: [message] });
}
