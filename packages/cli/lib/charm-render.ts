import { render } from "@commontools/html";
import { UI } from "@commontools/runner";
import { inspectCharm } from "./charm.ts";
import type { CharmConfig } from "./charm.ts";

/**
 * Renders a charm's UI to HTML using JSDOM.
 * This is Phase 1 - static rendering only, no reactivity.
 */
export async function renderCharm(config: CharmConfig): Promise<string> {
  // Dynamically import JSDOM to avoid top-level import issues
  const { JSDOM } = await import("npm:jsdom");
  
  // 1. Setup JSDOM environment
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
  const { window } = dom;
  
  // Set up global DOM objects needed by the render system
  globalThis.document = window.document;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Text = window.Text;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.MutationObserver = window.MutationObserver;
  
  try {
    // 2. Get charm data using existing inspectCharm function
    const charmData = await inspectCharm(config);
    const vnode = charmData.result?.[UI];
    
    if (!vnode) {
      throw new Error(`Charm ${config.charm} has no UI`);
    }
    
    // 3. Get the root container
    const container = window.document.getElementById("root");
    if (!container) {
      throw new Error("Could not find root container");
    }
    
    // 4. Render the static VNode to the container
    render(container, vnode);
    
    // 5. Return the rendered HTML
    return container.innerHTML;
  } finally {
    // Clean up JSDOM
    window.close();
  }
}