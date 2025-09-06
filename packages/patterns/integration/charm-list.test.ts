import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("allCharms integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let allCharmsCharmId: string;
  let counterCharmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });

    const counterCharm = await cc.create(
      await Deno.readTextFile(
        join(import.meta.dirname!, "..", "counter.tsx"),
      ),
    );
    counterCharmId = counterCharm.id;

    const allCharmsCharm = await cc.create(
      await Deno.readTextFile(
        join(import.meta.dirname!, "..", "charms-list.tsx"),
      ),
    );
    allCharmsCharmId = allCharmsCharm.id;

    const allCharmsWellKnownId = "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";
    await cc.manager().link(
      allCharmsWellKnownId,
      [],
      allCharmsCharmId,
      ["allCharms"]
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the allCharms charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: allCharmsCharmId,
      identity,
    });

    await page.waitForSelector("#charms-heading", { strategy: "pierce" });
    await sleep(1000);
  });

  it("should display the correct number of charms", async () => {
    const page = shell.page();

    const heading = await page.waitForSelector("#charms-heading", { strategy: "pierce" });
    const headingText = await heading.evaluate((el: HTMLElement) => el.textContent);

    assert(headingText?.includes("Charms ("));
    assert(headingText?.includes("2"));
  });

  it("should display charm cards in a grid", async () => {
    const page = shell.page();

    await page.waitForSelector("#charms-grid", { strategy: "pierce" });
    const charmCards = await page.$$("[id^='charm-card-']", { strategy: "pierce" });

    assertEquals(charmCards.length, 2);
  });

  it("should show charm names correctly", async () => {
    const page = shell.page();

    const charmNames = await page.$$("[id^='charm-name-']", { strategy: "pierce" });
    assertEquals(charmNames.length, 2);

    const nameTexts = await Promise.all(
      charmNames.map(nameEl =>
        nameEl.evaluate((el: HTMLElement) => el.textContent?.trim())
      )
    );

    const hasCounterCharm = nameTexts.some(name => name?.includes("Simple counter"));
    const hasAllCharmsCharm = nameTexts.some(name => name?.includes("Charms"));

    assert(hasCounterCharm);
    assert(hasAllCharmsCharm);
  });

  it("should have Visit buttons for each charm", async () => {
    const page = shell.page();

    const actualVisitButtons = await page.$$("[id^='visit-button-']", { strategy: "pierce" });
    assertEquals(actualVisitButtons.length, 2);
  });

  it("should navigate when clicking a Visit button", async () => {
    const page = shell.page();

    const urlBefore = await page.evaluate(() => globalThis.location.href);
    const visitButtons = await page.$$("[id^='visit-button-']", { strategy: "pierce" });
    assert(visitButtons.length > 0);
    const visitButton = visitButtons[0];
    await visitButton.click();

    await sleep(400);

    const hasValidContent = await page.waitForSelector("#counter-result, h2", { strategy: "pierce" });
    assert(hasValidContent);
  });
});
