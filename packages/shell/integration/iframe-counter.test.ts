import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { registerCharm, ShellIntegration } from "./utils.ts";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import "../src/globals.ts";

const { API_URL, FRONTEND_URL } = env;

describe("shell iframe counter tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can view and interact with iframe counter", async () => {
    const { page, identity } = shell.get();
    const spaceName = globalThis.crypto.randomUUID();

    // Register the iframe counter recipe as a charm
    const charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "integration",
          "iframe-counter-recipe.tsx",
        ),
      ),
    });

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}shell/${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login and verify state
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);
    assertEquals(
      state.identity?.serialize().privateKey,
      identity.serialize().privateKey,
    );

    // Wait for iframe content to load
    await sleep(3000);

    // Test basic increment
    let incrementBtn = await page.$("pierce/#increment-btn");
    assert(incrementBtn, "Increment button should be found");
    
    // Click increment button 3 times
    await incrementBtn.click();
    await sleep(500);
    await incrementBtn.click();
    await sleep(500);
    await incrementBtn.click();
    await sleep(1000);

    // Verify counter value is 3
    // The counter display is in a div with specific styling
    const counterDisplay = await page.evaluate(() => {
      // Pierce through shadow DOM to find the counter display
      const pierce = (root: Element | ShadowRoot, selector: string): Element | null => {
        const directMatch = root.querySelector(selector);
        if (directMatch) return directMatch;
        
        const shadowHosts = Array.from(
          root.querySelectorAll("*")
        ).filter(el => el.shadowRoot);
        
        for (const host of shadowHosts) {
          const match = pierce(host.shadowRoot!, selector);
          if (match) return match;
        }
        
        // Check iframes
        const iframes = root.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const match = iframeDoc.querySelector(selector);
              if (match) return match;
            }
          } catch (e) {
            // Cross-origin iframe, skip
          }
        }
        
        return null;
      };
      
      // Look for the counter display - it's a div with text-5xl class
      const counterEl = pierce(document.body, ".text-5xl");
      return counterEl?.textContent;
    });
    
    assertEquals(counterDisplay, "3", "Counter should be 3 after 3 increments");

    // Test decrement
    const decrementBtn = await page.$("pierce/#decrement-btn");
    assert(decrementBtn, "Decrement button should be found");
    
    await decrementBtn.click();
    await sleep(1000);

    // Verify counter value is 2
    const counterAfterDecrement = await page.evaluate(() => {
      const pierce = (root: Element | ShadowRoot, selector: string): Element | null => {
        const directMatch = root.querySelector(selector);
        if (directMatch) return directMatch;
        
        const shadowHosts = Array.from(
          root.querySelectorAll("*")
        ).filter(el => el.shadowRoot);
        
        for (const host of shadowHosts) {
          const match = pierce(host.shadowRoot!, selector);
          if (match) return match;
        }
        
        const iframes = root.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const match = iframeDoc.querySelector(selector);
              if (match) return match;
            }
          } catch (e) {
            // Cross-origin iframe, skip
          }
        }
        
        return null;
      };
      
      const counterEl = pierce(document.body, ".text-5xl");
      return counterEl?.textContent;
    });
    
    assertEquals(counterAfterDecrement, "2", "Counter should be 2 after decrement");
  });

  it("can click increment button multiple times and verify count", async () => {
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
          "integration",
          "iframe-counter-recipe.tsx",
        ),
      ),
    });

    await page.goto(`${FRONTEND_URL}shell/${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();
    await shell.login();

    // Wait for iframe to load
    await sleep(3000);

    // Click increment button 5 times
    const incrementBtn = await page.$("pierce/#increment-btn");
    assert(incrementBtn, "Increment button should be found");
    
    for (let i = 0; i < 5; i++) {
      await incrementBtn.click();
      await sleep(300);
    }

    await sleep(1000);

    // Verify counter is 5
    const counterValue = await page.evaluate(() => {
      const pierce = (root: Element | ShadowRoot, selector: string): Element | null => {
        const directMatch = root.querySelector(selector);
        if (directMatch) return directMatch;
        
        const shadowHosts = Array.from(
          root.querySelectorAll("*")
        ).filter(el => el.shadowRoot);
        
        for (const host of shadowHosts) {
          const match = pierce(host.shadowRoot!, selector);
          if (match) return match;
        }
        
        const iframes = root.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const match = iframeDoc.querySelector(selector);
              if (match) return match;
            }
          } catch (e) {
            // Cross-origin iframe, skip
          }
        }
        
        return null;
      };
      
      const counterEl = pierce(document.body, ".text-5xl");
      return counterEl?.textContent;
    });
    
    assertEquals(counterValue, "5", "Counter should be 5 after 5 increments");

    // Test reset button
    const resetBtn = await page.evaluate(() => {
      const pierce = (root: Element | ShadowRoot, selector: string): Element | null => {
        const directMatch = root.querySelector(selector);
        if (directMatch) return directMatch;
        
        const shadowHosts = Array.from(
          root.querySelectorAll("*")
        ).filter(el => el.shadowRoot);
        
        for (const host of shadowHosts) {
          const match = pierce(host.shadowRoot!, selector);
          if (match) return match;
        }
        
        const iframes = root.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const match = iframeDoc.querySelector(selector);
              if (match) return match;
            }
          } catch (e) {
            // Cross-origin iframe, skip
          }
        }
        
        return null;
      };
      
      // Find and click the reset button
      const resetButton = pierce(document.body, "button.bg-gray-200");
      if (resetButton && resetButton instanceof HTMLElement) {
        resetButton.click();
        return true;
      }
      return false;
    });
    
    assert(resetBtn, "Reset button should be found and clicked");
    await sleep(1000);

    // Verify counter is back to 0
    const counterAfterReset = await page.evaluate(() => {
      const pierce = (root: Element | ShadowRoot, selector: string): Element | null => {
        const directMatch = root.querySelector(selector);
        if (directMatch) return directMatch;
        
        const shadowHosts = Array.from(
          root.querySelectorAll("*")
        ).filter(el => el.shadowRoot);
        
        for (const host of shadowHosts) {
          const match = pierce(host.shadowRoot!, selector);
          if (match) return match;
        }
        
        const iframes = root.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const match = iframeDoc.querySelector(selector);
              if (match) return match;
            }
          } catch (e) {
            // Cross-origin iframe, skip
          }
        }
        
        return null;
      };
      
      const counterEl = pierce(document.body, ".text-5xl");
      return counterEl?.textContent;
    });
    
    assertEquals(counterAfterReset, "0", "Counter should be 0 after reset");
  });
});