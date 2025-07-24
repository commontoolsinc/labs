import { render } from "@commontools/html";
import { Cell, effect, UI } from "@commontools/runner";
import { inspectCharm, loadManager } from "./charm.ts";
import { CharmsController } from "@commontools/charm/ops";
import type { CharmConfig } from "./charm.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("charm-render", { level: "info", enabled: true });

export interface RenderOptions {
  watch?: boolean;
  onUpdate?: (html: string) => void;
}

/**
 * Renders a charm's UI to HTML using JSDOM.
 * Supports both static and reactive rendering with --watch mode.
 */
export async function renderCharm(
  config: CharmConfig,
  options: RenderOptions = {},
): Promise<string | (() => void)> {
  // Dynamically import JSDOM to avoid top-level import issues
  const { JSDOM } = await import("npm:jsdom");

  // 1. Setup JSDOM environment
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
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
    // 2. Get charm controller to access the Cell
    const manager = await loadManager(config);
    const charms = new CharmsController(manager);
    const charm = await charms.get(config.charm);
    const cell = charm.getCell();

    // Check if charm has UI
    const staticValue = cell.get();
    if (!staticValue?.[UI]) {
      throw new Error(`Charm ${config.charm} has no UI`);
    }

    // 3. Get the root container
    const container = window.document.getElementById("root");
    if (!container) {
      throw new Error("Could not find root container");
    }

    if (options.watch) {
      // 4a. Reactive rendering - pass the Cell directly
      const uiCell = cell.key(UI);
      const cancel = render(container, uiCell);

      // 5a. Set up monitoring for changes
      let updateCount = 0;
      const unsubscribe = cell.sink((value) => {
        if (value?.[UI]) {
          updateCount++;
          // Wait for all runtime computations to complete
          manager.runtime.idle().then(() => {
            const html = container.innerHTML;
            logger.info(() => `[Update ${updateCount}] UI changed`);
            if (options.onUpdate) {
              options.onUpdate(html);
            }
          });
        }
      });

      // Return cleanup function
      return () => {
        cancel();
        unsubscribe();
        window.close();
      };
    } else {
      // 4b. Static rendering - render once with current value
      const vnode = staticValue[UI];
      render(container, vnode);

      // 5b. Return the rendered HTML
      return container.innerHTML;
    }
  } finally {
    // Clean up JSDOM only in static mode
    if (!options.watch) {
      window.close();
    }
  }
}
