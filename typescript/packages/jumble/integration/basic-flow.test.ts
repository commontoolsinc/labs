import { Browser, launch, Page } from "@astral/astral";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import {
  addCharm,
  assertAndSnapshot,
  inspectCharm,
  login,
  sleep,
  waitForSelectorWithText,
} from "./utils.ts";

const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:5173/";
const HEADLESS = true;

console.log(`TOOLSHED_API_URL=${TOOLSHED_API_URL}`);
console.log(`FRONTEND_URL=${FRONTEND_URL}`);

describe("integration", () => {
  let browser: Browser | void = undefined;
  let page: Page | void = undefined;
  let testCharm: { charmId: string; space: string } | void = undefined;

  beforeAll(async () => {
    testCharm = await addCharm(TOOLSHED_API_URL);
    console.log(`Charm added`, testCharm);
    browser = await launch({ headless: HEADLESS });
  });
  beforeEach(async () => {
    console.log(`Waiting to open website at ${FRONTEND_URL}`);
    page = await browser!.newPage(FRONTEND_URL);
    console.log(`Opened website at ${FRONTEND_URL}`);
    await login(page);
  });
  afterEach(async () => {
    await page!.close();
  });
  afterAll(async () => {
    await browser!.close();
  });

  it("renders a new charm", async () => {
    assertAndSnapshot(page, "Page should be defined");
    assertAndSnapshot(testCharm, "Test charm should be defined");

    const anchor = await page!.waitForSelector("nav a");
    const innerText = await anchor.innerText();
    assertAndSnapshot(
      innerText === "common-knowledge",
      "Logged in and Common Knowledge title renders",
      page,
      "logged_in_state",
    );

    await page!.goto(
      `${FRONTEND_URL}${testCharm!.space}/${testCharm!.charmId}`,
    );
    console.log(`Waiting for charm to render`);

    await waitForSelectorWithText(
      page!,
      "a[aria-current='charm-title']",
      "Simple Value: 1",
    );
    console.log("Charm rendered.");
    await assertAndSnapshot(
      true,
      "Charm rendered successfully",
      page,
      "charm_rendered",
    );

    console.log("Clicking button");
    // Sometimes clicking this button throws:
    // https://jsr.io/@astral/astral/0.5.2/src/element_handle.ts#L192
    // As if the reference was invalidated by a spurious re-render between
    // getting an element handle, and clicking it.
    await sleep(1000);
    const button = await page!.waitForSelector(
      "div[aria-label='charm-content'] button",
    );
    await button.click();
    await assertAndSnapshot(true, "Button clicked", page, "button_clicked");

    console.log("Checking if title changed");
    await waitForSelectorWithText(
      page!,
      "a[aria-current='charm-title']",
      "Simple Value: 2",
    );
    console.log("Title changed");
    await assertAndSnapshot(
      true,
      "Title changed successfully",
      page,
      "title_changed",
    );

    console.log("Inspecting charm to verify updates propagated from browser.");
    const charm = await inspectCharm(
      TOOLSHED_API_URL,
      testCharm!.space,
      testCharm!.charmId,
    );
    console.log("Charm:", charm);
    assertAndSnapshot(
      charm.includes("Simple Value: 2"),
      "Charm updates propagated.",
      page,
      "updates_propagated",
    );
  });

  // Placeholder test ensuring browser can be used
  // across multiple tests (replace when we have more integration tests!)
  it("[placeholder]", () => {
    assertAndSnapshot(page, "Page should be defined");
    assertAndSnapshot(testCharm, "Test charm should be defined");
  });
});
