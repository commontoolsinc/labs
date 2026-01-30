import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { PiecesController } from "@commontools/piece/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { TEST_LLM } from "./flags.ts";

const { API_URL, FRONTEND_URL } = env;
// Use a unique space name to avoid conflicts
const SPACE_NAME = "chat-note-test-" +
  Temporal.Now.instant().epochMilliseconds.toString(36);
const ignore = !TEST_LLM;

describe("Chat Note pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let pieceId: string;
  let identity: Identity;
  let cc: PiecesController;

  if (!ignore) {
    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      cc = await PiecesController.initialize({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });

      // First visit the space to create the Default App
      const page = shell.page();
      await page.goto(`${FRONTEND_URL}/${SPACE_NAME}`);
      await sleep(3000); // Wait for space initialization

      // Create the chat-note piece
      const piece = await cc.create(
        await Deno.readTextFile(
          join(import.meta.dirname!, "..", "experimental", "chat-note.tsx"),
        ),
        { start: true },
      );
      pieceId = piece.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the chat-note piece and display initial UI",
    ignore,
    fn: async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });

      // Wait for the component to render
      await sleep(2000);

      // Check for the title (should contain "Chat Note" by default)
      const titleElement = await page.waitForSelector("span", {
        strategy: "pierce",
      });
      assert(titleElement, "Should find title element");

      // Check for the code editor
      const editor = await page.waitForSelector("ct-code-editor", {
        strategy: "pierce",
      });
      assert(editor, "Should find code editor element");

      // Check for the Generate button
      const generateButton = await page.waitForSelector(
        'ct-button[variant="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");

      const buttonText = await generateButton.evaluate(
        (el: HTMLElement) => el.textContent,
      );
      assertEquals(buttonText?.trim(), "Generate");
    },
  });

  it({
    name: "should allow typing content in the editor",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Find the CodeMirror editor content area
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      assert(editorContent, "Should find CodeMirror content area");

      // Click to focus the editor
      await editorContent.click();
      await sleep(500);

      // Type some content
      await page.keyboard.type("Hello, this is a test message.");
      await sleep(1000);

      // Verify the content was entered
      const content = await editorContent.evaluate(
        (el: HTMLElement) => el.textContent,
      );
      assert(
        content?.includes("Hello, this is a test message"),
        "Editor should contain typed content",
      );
    },
  });

  it({
    name: "should enable Generate button when content is present",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait a bit for the button state to update
      await sleep(500);

      // Find the Generate button
      const generateButton = await page.waitForSelector(
        'ct-button[variant="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");

      // Check that the button is not disabled (has content)
      const isDisabled = await generateButton.evaluate(
        (el: HTMLElement) => el.hasAttribute("disabled"),
      );

      // Button should be enabled since we have content
      assertEquals(isDisabled, false, "Generate button should be enabled");
    },
  });

  it({
    name: "should trigger generation when Generate button is clicked",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Click the Generate button
      const generateButton = await page.waitForSelector(
        'ct-button[variant="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");
      await generateButton.click();

      // Wait for the UI to update - should show loading state or Cancel button
      await sleep(1000);

      // Check that the editor now contains the AI header
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      const content = await editorContent?.evaluate(
        (el: HTMLElement) => el.textContent,
      );

      assert(
        content?.includes("## AI"),
        "Editor should contain AI header after clicking Generate",
      );

      // Wait for generation to complete (or timeout)
      // The Cancel button should appear during generation
      try {
        const cancelButton = await page.waitForSelector(
          'ct-button:has-text("Cancel")',
          { strategy: "pierce", timeout: 5000 },
        );
        if (cancelButton) {
          // Generation is in progress, wait for it to complete
          await sleep(10000);
        }
      } catch {
        // Cancel button not found, generation might have completed quickly
      }

      // After generation, check that we have a response
      await sleep(2000);
      const finalContent = await editorContent?.evaluate(
        (el: HTMLElement) => el.textContent,
      );

      // The content should now have some AI response
      assert(
        finalContent && finalContent.length > content!.length,
        "Editor should have more content after generation",
      );
    },
  });

  it({
    name: "should parse system prompt from ## System header",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Navigate fresh to clear state
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });

      await sleep(2000);

      // Find and focus the editor
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      assert(editorContent, "Should find editor");

      // Clear existing content by selecting all and deleting
      // Use OS-specific modifier: Meta on macOS, Control on Windows/Linux
      await editorContent.click();
      const modifier = Deno.build.os === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(modifier);
      await page.keyboard.press("a");
      await page.keyboard.up(modifier);
      await page.keyboard.press("Backspace");
      await sleep(500);

      // Type content with a system prompt
      const testContent = `## System
You are a pirate who speaks only in pirate talk.

---
Say hello`;

      await page.keyboard.type(testContent);
      await sleep(1000);

      // Click Generate
      const generateButton = await page.waitForSelector(
        'ct-button[variant="primary"]',
        { strategy: "pierce" },
      );
      await generateButton?.click();

      // Wait for response
      await sleep(15000);

      // Check that the response includes pirate-like content
      const finalContent = await editorContent?.evaluate(
        (el: HTMLElement) => el.textContent,
      );

      assert(
        finalContent?.includes("## AI"),
        "Should have AI response section",
      );

      // The response should have some pirate-themed content
      // (We can't guarantee exact wording, but the LLM should follow the system prompt)
      console.log("Response content:", finalContent);
    },
  });
});
