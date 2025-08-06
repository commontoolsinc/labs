/**
 * Utility functions for navigating through shadow DOM boundaries in tests
 */

type Page = any; // The Page type from integration utils

/**
 * Traverses through shadow DOM boundaries following a path of selectors
 * @param page - The page object
 * @param path - Array of selectors to traverse through shadow DOMs
 * @returns The element at the end of the path, or null if not found
 */
export async function traverseShadowDOM(
  page: Page,
  path: string[],
): Promise<any> {
  return await page.evaluate((selectors: string[]) => {
    let current: Document | Element | ShadowRoot | null = document;
    
    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      
      if (!current) {
        console.error(`Lost element at step ${i}`);
        return null;
      }
      
      // Query the current context (document, element, or shadow root)
      let next: Element | null = null;
      
      if (current instanceof Document) {
        next = current.querySelector(selector);
      } else if (current instanceof ShadowRoot) {
        next = current.querySelector(selector);
      } else if (current instanceof Element) {
        // First try shadow root if it exists
        if (current.shadowRoot) {
          next = current.shadowRoot.querySelector(selector);
        }
        // If not found in shadow root (or no shadow root), try regular DOM
        if (!next) {
          next = current.querySelector(selector);
        }
      }
      
      if (!next) {
        console.error(`Could not find "${selector}" at step ${i}`);
        return null;
      }
      
      // For the next iteration, we'll search in this element's shadow root if it has one,
      // otherwise we'll search in the element itself
      current = next;
    }
    
    // Return the final element (not its shadow root)
    if (current instanceof ShadowRoot) {
      return current.host;
    }
    return current;
  }, { args: [path] });
}

/**
 * Clicks an element deep in shadow DOM
 * @param page - The page object
 * @param path - Array of selectors to traverse through shadow DOMs
 */
export async function clickShadowElement(
  page: Page,
  path: string[],
): Promise<void> {
  await page.evaluate((selectors: string[]) => {
    let current: Document | Element | ShadowRoot | null = document;
    
    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      
      if (!current) {
        throw new Error(`Lost element at step ${i}`);
      }
      
      let next: Element | null = null;
      
      if (current instanceof Document) {
        next = current.querySelector(selector);
      } else if (current instanceof ShadowRoot) {
        next = current.querySelector(selector);
      } else if (current instanceof Element) {
        // First try shadow root if it exists
        if (current.shadowRoot) {
          next = current.shadowRoot.querySelector(selector);
        }
        // If not found in shadow root (or no shadow root), try regular DOM
        if (!next) {
          next = current.querySelector(selector);
        }
      }
      
      if (!next) {
        throw new Error(`Could not find "${selector}" at step ${i} of path: ${selectors.join(' > ')}`);
      }
      
      // For the last element, click it
      if (i === selectors.length - 1) {
        (next as HTMLElement).click();
        return;
      }
      
      // For the next iteration, continue searching from this element
      current = next;
    }
  }, { args: [path] });
}

/**
 * Types text into an input element deep in shadow DOM
 * @param page - The page object
 * @param path - Array of selectors to traverse through shadow DOMs
 * @param text - Text to type
 */
export async function typeInShadowInput(
  page: Page,
  path: string[],
  text: string,
): Promise<void> {
  await page.evaluate((selectors: string[], value: string) => {
    let current: Document | Element | ShadowRoot | null = document;
    
    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      
      if (!current) {
        throw new Error(`Lost element at step ${i}`);
      }
      
      let next: Element | null = null;
      
      if (current instanceof Document) {
        next = current.querySelector(selector);
      } else if (current instanceof ShadowRoot) {
        next = current.querySelector(selector);
      } else if (current instanceof Element) {
        // First try shadow root if it exists
        if (current.shadowRoot) {
          next = current.shadowRoot.querySelector(selector);
        }
        // If not found in shadow root (or no shadow root), try regular DOM
        if (!next) {
          next = current.querySelector(selector);
        }
      }
      
      if (!next) {
        throw new Error(`Could not find "${selector}" at step ${i} of path: ${selectors.join(' > ')}`);
      }
      
      // For the last element, type into it
      if (i === selectors.length - 1) {
        const input = next as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      
      // For the next iteration, continue searching from this element
      current = next;
    }
  }, { args: [path, text] });
}