import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { type Cell, UI } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { loadManager } from "./piece.ts";
import { PiecesController } from "@commonfabric/piece/ops";
import type { PieceConfig } from "./piece.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("piece-render", { level: "info", enabled: false });

export interface RenderOptions {
  watch?: boolean;
  onUpdate?: (html: string) => void;
  start?: boolean;
}

/**
 * Renders a piece's UI to HTML using htmlparser2.
 * Supports both static and reactive rendering with --watch mode.
 *
 * The reconciler and the DOM applicator both run here, in the CLI's own
 * process, against a mock document. That is the same pair a browser uses, so
 * the tree serialized below is the tree a browser would show.
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
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(
    config.piece,
    options.start ?? true,
    undefined,
    config.pieceScope,
  );
  const cell = piece.getCell().asSchema({
    type: "object",
    properties: {
      [UI]: rendererVDOMSchema,
    },
    required: [UI],
  }) as Cell<Record<string, unknown>>;

  // Check if piece has UI
  if (!cell.get()?.[UI]) {
    throw new Error(`Piece ${config.piece} has no UI`);
  }

  // 3. Get the root container
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Could not find root container");
  }

  // 4. Mount the piece's [UI]. In watch mode `report` takes over once the
  // render exists; until then applied batches need no announcement.
  let report = () => {};
  const render = renderInProcess(container, cell.key(UI), {
    document,
    setProp: renderOptions.setProp,
    onError: (error) => {
      logger.info("piece-render", () => `render error: ${error.message}`);
    },
    onApplied: () => report(),
  });

  // Apply everything the reconciler produced, then read the tree.
  const flushAndRead = (): string => {
    render.flush();
    return container.innerHTML;
  };

  if (options.watch) {
    // Several batches can make up one update, and further batches can land
    // while a read is still waiting for the runtime. Reading once per quiet
    // runtime reports each settled tree exactly once. `reading` is cleared in
    // the same synchronous stretch as the read, so no batch lands unreported
    // between the two.
    let reading = false;
    let updateCount = 0;
    report = () => {
      if (reading) return;
      reading = true;
      manager.runtime.idle().then(() => {
        let html: string;
        try {
          html = flushAndRead();
        } finally {
          reading = false;
        }
        updateCount++;
        logger.info("piece-render", () => `[Update ${updateCount}] UI changed`);
        options.onUpdate?.(html);
      }).catch((error: unknown) => {
        logger.info("piece-render", () => `watch read failed: ${error}`);
      });
    };
    return () => render.cancel();
  }

  // 5. Static render: report the settled tree once.
  try {
    await manager.runtime.idle();
    return flushAndRead();
  } finally {
    render.cancel();
  }
}
