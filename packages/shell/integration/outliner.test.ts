import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Browser, Page } from "@commontools/integration";
import { Identity } from "@commontools/identity";
import { login, registerCharm } from "./utils.ts";

const API_URL = globalThis.TESTAPI_URL || "http://localhost:8000/";
const ASTRAL_TIMEOUT = 60_000;
const HEADLESS = Deno.env.get("HEADLESS") !== "0";

describe("ct-outliner integration tests", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let identity: Identity | undefined;
  let spaceName: string;
  let charmId: string;

  beforeAll(async () => {
    // Launch browser
    browser = await Browser.launch({
      timeout: ASTRAL_TIMEOUT,
      headless: HEADLESS,
    });

    // Set up identity and space name
    identity = await Identity.generate({ implementation: "noble" });
    spaceName = globalThis.crypto.randomUUID();
  });

  beforeEach(async () => {
    // Create new page for each test
    page = await browser!.newPage();

    // Set up event listeners
    page.addEventListener("console", (e) => {
      console.log("Browser:", e.detail.text);
    });

    page.addEventListener("dialog", (e) => {
      console.log("Dialog:", e.detail.message);
      e.detail.accept();
    });

    const exceptions: string[] = [];
    page.addEventListener("pageerror", (e) => {
      console.error("Browser Page Error:", e.detail.message);
      exceptions.push(e.detail.message);
    });

    // Deploy the outliner recipe
    const outlinerSource = await Deno.readTextFile(
      new URL("../../../recipes/outliner.tsx", import.meta.url),
    );

    charmId = await registerCharm({
      spaceName,
      apiUrl: new URL(API_URL),
      identity: identity!,
      source: outlinerSource,
    });

    // Navigate to the shell with the outliner charm
    await page.goto(`${API_URL}shell/${spaceName}/${charmId}`);

    // Log in with the identity
    await login(page, identity!);

    // Wait for the charm to load
    await page.waitForSelector("pierce/ct-outliner", { timeout: 10000 });
  });

  it("should add text to root node using click and keyboard", async () => {
    // Find the outliner component
    const outliner = await page!.$("pierce/ct-outliner");
    expect(outliner).toBeTruthy();

    // Click on the placeholder to start typing
    const placeholder = await page!.$('pierce/.placeholder');
    expect(placeholder).toBeTruthy();
    await placeholder!.click();

    // Wait for the editor to appear
    await page!.waitForSelector("pierce/.content-editor", { timeout: 5000 });

    // Type some text
    const testText = "Hello from integration test!";
    await page!.keyboard.type(testText);

    // Press Enter to save the text
    await page!.keyboard.press("Enter");

    // Wait for the text to appear in the rendered content
    await page!.waitForFunction(
      (text) => {
        const outliner = document.querySelector("ct-outliner");
        if (!outliner || !outliner.shadowRoot) return false;
        const content = outliner.shadowRoot.querySelector(".markdown-content");
        return content && content.textContent?.includes(text);
      },
      { args: [testText], timeout: 5000 },
    );

    // Verify the text was saved by checking the outliner's state
    const state = await page!.evaluate(() => {
      const outliner = document.querySelector("ct-outliner") as any;
      return outliner?.tree || outliner?.value;
    });

    expect(state).toBeTruthy();
    expect(state.root).toBeTruthy();
    expect(state.root.children).toHaveLength(1);
    expect(state.root.children[0].body).toBe(testText);
  });

  it("should create multiple nodes with Enter key", async () => {
    // Click placeholder to start
    const placeholder = await page!.$('pierce/.placeholder');
    await placeholder!.click();

    // Type first line
    await page!.keyboard.type("First line");
    await page!.keyboard.press("Enter");

    // The first Enter saves and creates a new node
    // Now we should be editing a new empty node
    await page!.waitForSelector("pierce/.content-editor", { timeout: 5000 });

    // Type second line
    await page!.keyboard.type("Second line");
    await page!.keyboard.press("Enter");

    // Type third line
    await page!.keyboard.type("Third line");
    await page!.keyboard.press("Escape"); // Exit edit mode

    // Verify all three nodes were created
    const state = await page!.evaluate(() => {
      const outliner = document.querySelector("ct-outliner") as any;
      return outliner?.tree || outliner?.value;
    });

    expect(state.root.children).toHaveLength(3);
    expect(state.root.children[0].body).toBe("First line");
    expect(state.root.children[1].body).toBe("Second line");
    expect(state.root.children[2].body).toBe("Third line");
  });

  it("should edit existing node with double-click", async () => {
    // First create a node
    const placeholder = await page!.$('pierce/.placeholder');
    await placeholder!.click();
    await page!.keyboard.type("Original text");
    await page!.keyboard.press("Enter");
    await page!.keyboard.press("Escape"); // Exit edit mode

    // Double-click the node to edit
    const nodeContent = await page!.$('pierce/.node-content');
    expect(nodeContent).toBeTruthy();
    await nodeContent!.dblclick();

    // Wait for editor
    await page!.waitForSelector("pierce/.content-editor", { timeout: 5000 });

    // Clear and type new text
    await page!.keyboard.press("Control+A");
    await page!.keyboard.type("Updated text");
    await page!.keyboard.press("Enter");

    // Verify the text was updated
    const state = await page!.evaluate(() => {
      const outliner = document.querySelector("ct-outliner") as any;
      return outliner?.tree || outliner?.value;
    });

    expect(state.root.children).toHaveLength(1);
    expect(state.root.children[0].body).toBe("Updated text");
  });

  // Clean up after each test
  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  // Clean up after all tests
  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });
});