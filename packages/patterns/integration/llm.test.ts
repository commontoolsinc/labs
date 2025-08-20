import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// LLM tests are skipped in CI until we handle llm() calls properly in CI environments.
// This requires either:
// 1. Adding a flag to enable LLM tests in CI with proper API keys
// 2. Resurrecting the LLM cache functionality from toolshed
describe("LLM pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "llm.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it({
    name: "should load the LLM test charm and display initial UI",
    ignore: Deno.env.get("CI") === "true", // Skip in CI - see comment above
    fn: async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    // Wait for the component to render by waiting for title
    const title = await page.waitForSelector("h2", {
      strategy: "pierce",
    });
    assert(title, "Should find title element");

    const titleText = await title.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(titleText?.trim(), "LLM Test");

    // Check for the message input
    const messageInput = await page.waitForSelector("ct-message-input", {
      strategy: "pierce",
    });
    assert(messageInput, "Should find message input element");
    },
  });

  it({
    name: "should handle question input and display question",
    ignore: Deno.env.get("CI") === "true", // Skip in CI - see comment above
    fn: async () => {
    const page = shell.page();

    // Find the message input component
    const messageInput = await page.waitForSelector("ct-message-input", {
      strategy: "pierce",
    });
    assert(messageInput, "Should find message input");

    // Look for the actual input element inside the message input component
    const inputElement = await page.waitForSelector("input", {
      strategy: "pierce",
    });
    assert(inputElement, "Should find input element");

    // Type a question
    const testQuestion = "What is 2 + 2?";
    await inputElement.type(testQuestion);

    // Find and click the send button
    const sendButton = await page.waitForSelector("[data-ct-button]", {
      strategy: "pierce",
    });
    assert(sendButton, "Should find send button");
    await sendButton.click();

    // Wait for the question to appear by waiting for blockquote
    const questionSection = await page.waitForSelector("blockquote", {
      strategy: "pierce",
    });
    assert(questionSection, "Should find question blockquote");

    const questionText = await questionSection.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(questionText?.trim(), testQuestion);
    },
  });

  it({
    name: "should display LLM response after asking a question",
    ignore: Deno.env.get("CI") === "true", // Skip in CI - see comment above
    fn: async () => {
    const page = shell.page();

    // Wait for LLM response to appear (this may take some time)
    // The response appears in a <pre> element
    const responseElement = await page.waitForSelector("pre", {
      strategy: "pierce",
      timeout: 30000, // 30 second timeout for LLM response
    });
    assert(responseElement, "Should find LLM response element");

    const responseText = await responseElement.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(responseText, "Should have response text");
    assert(responseText.trim().length > 0, "Response should not be empty");

    // The response should contain some form of answer to "What is 2 + 2?"
    // We'll just check that we got some text back rather than checking exact content
    // since LLM responses can vary
    console.log("LLM Response:", responseText);
    },
  });

  it({
    name: "should handle multiple questions in sequence",
    ignore: Deno.env.get("CI") === "true", // Skip in CI - see comment above
    fn: async () => {
    const page = shell.page();

    // Reduced wait for system to settle (was 2000ms)
    await sleep(200);

    // Ask a second question - need to refocus the input first
    const inputElement = await page.waitForSelector("input", {
      strategy: "pierce",
    });
    assert(inputElement, "Should find input element");

    // Focus and clear previous input, then type new question
    await inputElement.click(); // Focus the input
    await inputElement.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });

    const secondQuestion = "What is the capital of France?";
    await inputElement.type(secondQuestion);

    const sendButton = await page.waitForSelector("[data-ct-button]", {
      strategy: "pierce",
    });
    await sendButton.click();

    // Wait for UI to update
    await sleep(200);

    // Check that the new question is displayed
    const questionSection = await page.waitForSelector("blockquote", {
      strategy: "pierce",
    });
    const questionText = await questionSection.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(questionText?.trim(), secondQuestion);

    // Wait for new response - increased timeout for LLM
    const responseElement = await page.waitForSelector("pre", {
      strategy: "pierce",
      timeout: 60000, // 60 second timeout for LLM response
    });
    const responseText = await responseElement.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(responseText, "Should have response text for second question");
    console.log("Second LLM Response:", responseText);
    },
  });
});
