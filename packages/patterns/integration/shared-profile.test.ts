import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForText } from "./cfc-browser-helpers.ts";

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
    await waitForText(page, "#shared-profile-name", "No profile");
    await waitForSelector(page, "#wish-profile-name-input");
    await waitForSelector(page, '[data-ui-pattern="ProfileCreateSurface"]');

    await submitProfileCreate(
      page,
      "cf-message-input#wish-profile-name-input",
      "Ada Lovelace",
    );
    await waitForText(page, "#shared-profile-name", "Ada Lovelace");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");

    await shell.login(secondIdentity);
    await shell.waitForState({
      identity: secondIdentity,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
    });
    await waitForText(page, "#shared-profile-name", "No profile");
    await waitForSelector(page, "#wish-profile-name-input");
    await waitForSelector(page, '[data-ui-pattern="ProfileCreateSurface"]');

    await submitProfileCreate(
      page,
      "cf-message-input#wish-profile-name-input",
      "Grace Hopper",
    );
    await waitForText(page, "#shared-profile-name", "Grace Hopper");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");
  });
});

async function waitForSelector(page: Page, selector: string) {
  await page.waitForSelector(selector, {
    strategy: "pierce",
    timeout: SHARED_PROFILE_TIMEOUT,
  });
}

async function submitProfileCreate(
  page: Page,
  inputSelector: string,
  message: string,
) {
  await page.waitForSelector(inputSelector, {
    strategy: "pierce",
    timeout: SHARED_PROFILE_TIMEOUT,
  });
  await page.evaluate((selector: string, value: string) => {
    const matches: Element[] = [];
    const visit = (root: Document | ShadowRoot) => {
      matches.push(...root.querySelectorAll(selector));
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    for (const element of matches) {
      element.dispatchEvent(
        new CustomEvent("cf-send", {
          bubbles: true,
          composed: true,
          detail: { message: value },
        }),
      );
    }
    return matches.length;
  }, { args: [inputSelector, message] });
}
