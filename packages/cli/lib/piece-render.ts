import { render } from "@commontools/html/client";
import { UI } from "@commontools/runner";
import { rendererVDOMSchema } from "@commontools/runner/schemas";
import { loadManager } from "./piece.ts";
import { CharmsController } from "@commontools/charm/ops";
import type { PieceConfig } from "./piece.ts";
import { getLogger } from "@commontools/utils/logger";
import { MockDoc } from "../../html/src/mock-doc.ts";
import { CellHandle, VNode } from "@commontools/runtime-client";

const logger = getLogger("piece-render", { level: "info", enabled: false });

export interface RenderOptions {
  watch?: boolean;
  onUpdate?: (html: string) => void;
  start?: boolean;
}

/**
 * Renders a piece's UI to HTML using htmlparser2.
 * Supports both static and reactive rendering with --watch mode.
 */
export async function renderPiece(
  config: PieceConfig,
  options: RenderOptions = {},
): Promise<string | (() => void)> {
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const { document, renderOptions } = mock;

  // 2. Get piece controller to access the Cell
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.piece, options.start ?? true);
  const cell = charm.getCell().asSchema({
    type: "object",
    properties: {
      [UI]: rendererVDOMSchema,
    },
    required: [UI],
  });

  // Check if piece has UI
  const staticValue = cell.get();
  if (!staticValue?.[UI]) {
    throw new Error(`Piece ${config.piece} has no UI`);
  }

  // 3. Get the root container
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Could not find root container");
  }

  if (options.watch) {
    // 4a. Reactive rendering - pass the Cell directly
    const uiCell = cell.key(UI);
    const cancel = render(
      container,
      uiCell as unknown as CellHandle<VNode>,
      renderOptions,
    ); // FIXME: types

    // 5a. Set up monitoring for changes
    let updateCount = 0;
    const unsubscribe = cell.sink((value) => {
      if (value?.[UI]) {
        updateCount++;
        // Wait for all runtime computations to complete
        manager.runtime.idle().then(() => {
          const html = container.innerHTML;
          logger.info(
            "piece-render",
            () => `[Update ${updateCount}] UI changed`,
          );
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
    };
  } else {
    // 4b. Static rendering - render once with current value
    const vnode = staticValue[UI];
    render(container, vnode as VNode, renderOptions); // FIXME: types

    // 5b. Return the rendered HTML
    return container.innerHTML;
  }
}
