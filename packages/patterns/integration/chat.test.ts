import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { TEST_LLM } from "./flags.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const ignore = !TEST_LLM;

// LLM tests are skipped in CI until we handle llm() calls properly in CI environments.
// This requires either:
// 1. Adding a flag to enable LLM tests in CI with proper API keys
// 2. Resurrecting the LLM cache functionality from toolshed
describe("Chat pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  if (!ignore) {
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
            "chat.tsx",
          ),
        ),
      );
      charmId = charm.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the Chat test charm and display initial UI",
    ignore,
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

      const titleText = await title.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(titleText?.trim(), "LLM Test");

      // Check for the message input
      const messageInput = await page.waitForSelector("ct-message-input", {
        strategy: "pierce",
      });
      assert(messageInput, "Should find message input element");

      // Check for clear chat button
      const clearButton = await page.waitForSelector("ct-button", {
        strategy: "pierce",
      });
      assert(clearButton, "Should find clear chat button");

      // Check for empty chat history (ul should exist but be empty initially)
      const chatHistory = await page.waitForSelector("ul", {
        strategy: "pierce",
      });
      assert(chatHistory, "Should find chat history container");
    },
  });

  it({
    name: "should handle message input and add to chat history",
    ignore,
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

      // Click to focus the input, then type the message
      await inputElement.click();
      const testMessage = "Hello, how are you?";
      await inputElement.type(testMessage);

      // Wait a bit for UI to process the input
      await sleep(100);

      // Click the send button by ID
      const sendButton = await page.waitForSelector("#ct-message-input-send-button", {
        strategy: "pierce",
      });
      assert(sendButton, "Should find send button");
      await sendButton.click();

      // Wait for the message to appear in chat history
      const chatHistory = await page.waitForSelector("ul", {
        strategy: "pierce",
      });
      assert(chatHistory, "Should find chat history container");

      // Check that the user message appears in the chat history
      const userMessage = await page.waitForSelector("li", {
        strategy: "pierce",
      });
      assert(userMessage, "Should find user message in chat history");

      const messageText = await userMessage.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assert(messageText?.includes(testMessage), "Should contain the user message");
      assert(messageText?.includes("user:"), "Should show user role prefix");
    },
  });

  it({
    name: "should display LLM response in chat history",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait for LLM response to appear (this may take some time)
      // The response appears as a list item with "assistant:" prefix
      // We'll wait for a second li element since the first one is the user message
      const messages = await page.waitForSelector("li + li", {
        strategy: "pierce",
        timeout: 30000, // 30 second timeout for LLM response
      });
      assert(messages, "Should find LLM response in chat history");

      const responseText = await messages.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assert(responseText, "Should have response text");
      assert(responseText.includes("assistant:"), "Should show assistant role prefix");
      assert(responseText.trim().length > "assistant:".length, "Response should not be empty");

      console.log("LLM Response:", responseText);
    },
  });

  it({
    name: "should handle multiple messages in chat sequence",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait for system to settle
      await sleep(200);

      // Ask a second question - need to refocus the input first
      const inputElement = await page.waitForSelector("input", {
        strategy: "pierce",
      });
      assert(inputElement, "Should find input element");

      // Focus and clear previous input, then type new message
      await inputElement.click(); // Focus the input
      await inputElement.evaluate((el: HTMLInputElement) => {
        el.value = "";
      });

      const secondMessage = "What is the capital of France?";
      await inputElement.type(secondMessage);

      // Wait a bit for UI to process the input
      await sleep(100);

      // Click the send button by ID
      const sendButton = await page.waitForSelector("#ct-message-input-send-button", {
        strategy: "pierce",
      });
      assert(sendButton, "Should find send button");
      await sendButton.click();

      // Wait for UI to update
      await sleep(200);

      // Check that we now have multiple messages in the chat history
      const allMessages = await page.waitForSelector("li", {
        strategy: "pierce",
      });
      assert(allMessages, "Should have messages in chat history");

      // Wait for new assistant response - look for at least 4 li elements total
      await page.waitForSelector("li + li + li + li", {
        strategy: "pierce",
        timeout: 60000, // 60 second timeout for LLM response
      });

      // Get all chat messages to verify sequence
      const chatHistory = await page.waitForSelector("ul", {
        strategy: "pierce",
      });
      const messages = await chatHistory.evaluate((ul: HTMLElement) => {
        const listItems = ul.querySelectorAll("li");
        return Array.from(listItems).map(li => li.textContent?.trim() || "");
      });

      // Should have at least 4 messages (user1, assistant1, user2, assistant2)
      assert(messages.length >= 4, `Should have at least 4 messages, got ${messages.length}`);
      
      // Verify the second user message is present
      const hasSecondUserMessage = messages.some(msg => 
        msg.includes("user:") && msg.includes(secondMessage)
      );
      assert(hasSecondUserMessage, "Should find second user message in chat history");

      console.log("Chat history:", messages);
    },
  });

  it({
    name: "should clear chat history when clear button is clicked",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Verify we have messages before clearing
      const chatHistoryBefore = await page.waitForSelector("ul", {
        strategy: "pierce",
      });
      const messagesBefore = await chatHistoryBefore.evaluate((ul: HTMLElement) => {
        return ul.querySelectorAll("li").length;
      });
      assert(messagesBefore > 0, "Should have messages before clearing");

      // Find and click the clear chat button
      const clearButton = await page.waitForSelector("ct-button", {
        strategy: "pierce",
      });
      assert(clearButton, "Should find clear chat button");
      await clearButton.click();

      // Wait for UI to update
      await sleep(200);

      // Verify chat history is now empty
      const chatHistoryAfter = await page.waitForSelector("ul", {
        strategy: "pierce",
      });
      const messagesAfter = await chatHistoryAfter.evaluate((ul: HTMLElement) => {
        return ul.querySelectorAll("li").length;
      });
      assertEquals(messagesAfter, 0, "Chat history should be empty after clearing");
    },
  });
});