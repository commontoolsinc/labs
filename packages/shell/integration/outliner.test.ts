import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Browser,
  dismissDialogs,
  Page,
  pipeConsole,
} from "@commontools/integration";
import { Identity } from "@commontools/identity";
import { login, registerCharm } from "./utils.ts";
import { sleep } from "@commontools/utils/sleep";
import { join } from "@std/path";
import { PageErrorEvent } from "@astral/astral";

const API_URL = (() => {
  const url = Deno.env.get("API_URL") ?? "http://localhost:8000";
  return url.substr(-1) === "/" ? url : `${url}/`;
})();
const ASTRAL_TIMEOUT = 60_000;
const HEADLESS = !!Deno.env.get("HEADLESS");

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

    // Deploy the outliner recipe once for all tests
    const outlinerSource = await Deno.readTextFile(
      join(
        import.meta.dirname!,
        "..",
        "..",
        "..",
        "recipes",
        "outliner.tsx",
      ),
    );

    charmId = await registerCharm({
      spaceName,
      apiUrl: new URL(API_URL),
      identity: identity!,
      source: outlinerSource,
    });
  });

  beforeEach(async () => {
    // Create new page for each test
    page = await browser!.newPage();

    // Set up event listeners with more verbose logging
    page.addEventListener("console", (e) => {
      console.log(`Browser Console [${e.detail.type}]:`, e.detail.text);
    });
    page.addEventListener("dialog", dismissDialogs);

    const exceptions: string[] = [];
    page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      exceptions.push(e.detail.message);
    });

    // Navigate to the outliner charm
    await page.goto(`${API_URL}shell/${spaceName}/${charmId}`);

    // Apply console formatter
    await page.applyConsoleFormatter();

    // Log in with the identity
    await login(page, identity!);

    // Wait for charm to load
    await sleep(10000);

    // Check if the outliner test content is in the markup
    const hasOutlinerTest = await page.evaluate(() => {
      const bodyHTML = document.body.innerHTML;
      const hasTestString = bodyHTML.includes("ct-outliner test");
      const hasOutlinerElement = !!document.querySelector("ct-outliner");

      // Look deeper in shadow DOMs
      const allElements = document.querySelectorAll("*");
      let foundInShadow = false;
      let shadowContent = "";
      for (const el of allElements) {
        if (el.shadowRoot) {
          const shadowHTML = el.shadowRoot.innerHTML;
          shadowContent += shadowHTML + " ";
          if (shadowHTML.includes("ct-outliner test")) {
            foundInShadow = true;
          }
        }
      }

      return {
        hasTestString,
        hasOutlinerElement,
        foundInShadow,
        bodySnippet: bodyHTML.substring(0, 800),
        shadowSnippet: shadowContent.substring(0, 800),
      };
    });

    console.log(
      "Outliner test search results:",
      JSON.stringify(hasOutlinerTest, null, 2),
    );

    // Check if we found the outliner content
    if (hasOutlinerTest.hasTestString || hasOutlinerTest.foundInShadow) {
      console.log("Found outliner test content in markup!");
      // Wait for the outliner element
      await page.$("pierce/ct-outliner");
    } else {
      console.log(
        "Outliner test content not found - charm may not be loading properly.",
      );
      console.log(
        "This indicates an issue with charm deployment or compilation.",
      );
      console.log(
        "The test framework is working correctly but the outliner charm is not rendering.",
      );

      // Try to wait for the element anyway, but expect it to fail
      try {
        await page.$("pierce/ct-outliner");
        console.log("Unexpectedly found ct-outliner element!");
      } catch (error) {
        console.log(
          "As expected, ct-outliner element not found. Test setup is working but charm is not loading.",
        );
        throw new Error(
          "Outliner charm not loading - check charm compilation and deployment",
        );
      }
    }
  });

  it("should add text to root node using click and keyboard", async () => {
    // Find the outliner component
    const outliner = await page!.$("pierce/ct-outliner");
    expect(outliner).toBeTruthy();

    // Click on the placeholder to start typing - it's inside ct-outliner's shadow DOM
    const placeholder = await page!.$("pierce/.placeholder");
    expect(placeholder).toBeTruthy();
    placeholder!.click();
    await sleep(500);

    // Wait for the editor to appear
    await page!.$("pierce/.content-editor");

    // Type some text
    const testText = "Hello from integration test!";
    await page!.keyboard.type(testText);

    // Press Enter to save the text
    page!.keyboard.press("Enter");

    // Wait for the text to appear in the rendered content
    await page!.evaluate(
      async (text: string) => {
        // Poll until the text appears
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          const outliner = document.querySelector("ct-outliner");
          if (outliner && outliner.shadowRoot) {
            const content = outliner.shadowRoot.querySelector(
              ".markdown-content",
            );
            if (content && content.textContent?.includes(text)) {
              return true;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Timeout waiting for text to appear");
      },
      { args: [testText] },
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
    const placeholder = await page!.$("pierce/.placeholder");
    placeholder!.click();
    await sleep(500);

    // Type first line
    await page!.keyboard.type("First line");
    page!.keyboard.press("Enter");

    // The first Enter saves and creates a new node
    // Now we should be editing a new empty node
    await page!.waitForSelector("pierce/.content-editor", { timeout: 5000 });

    // Type second line
    await page!.keyboard.type("Second line");
    page!.keyboard.press("Enter");

    // Type third line
    await page!.keyboard.type("Third line");
    page!.keyboard.press("Escape"); // Exit edit mode

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
    const placeholder = await page!.$("pierce/.placeholder");
    placeholder!.click();
    await page!.keyboard.type("Original text");
    page!.keyboard.press("Enter");
    page!.keyboard.press("Escape"); // Exit edit mode

    // Double-click the node to edit
    const nodeContent = await page!.$("pierce/.node-content");
    expect(nodeContent).toBeTruthy();
    // Perform double click using two clicks
    nodeContent!.click();
    await sleep(100);
    nodeContent!.click();
    await sleep(500);

    // Wait for editor
    await page!.waitForSelector("pierce/.content-editor", { timeout: 5000 });

    // Clear and type new text - select all with Ctrl+A or Cmd+A
    const isMac = Deno.build.os === "darwin";
    await page!.keyboard.down(isMac ? "Meta" : "Control");
    page!.keyboard.press("a");
    await page!.keyboard.up(isMac ? "Meta" : "Control");
    await page!.keyboard.type("Updated text");
    page!.keyboard.press("Enter");

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
