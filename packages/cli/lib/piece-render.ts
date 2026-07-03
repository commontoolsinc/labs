import { render } from "@commonfabric/html/client";
import { UI } from "@commonfabric/runner";
import { loadManager } from "./piece.ts";
import { PiecesController } from "@commonfabric/piece/ops";
import type { PieceConfig } from "./piece.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { MockDoc } from "../../html/src/mock-doc.ts";
import type { VNode } from "@commonfabric/runtime-client";

const logger = getLogger("piece-render", { level: "info", enabled: false });
const cliRendererVDOMSchema = {
  $defs: {
    vdomRenderNode: {
      anyOf: [
        { $ref: "#/$defs/vdomNode" },
        { $ref: "#/$defs/vdomRenderableObject" },
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "undefined" },
        {
          type: "array",
          items: { $ref: "#/$defs/vdomRenderNode" },
        },
      ],
    },
    vdomNode: {
      type: "object",
      properties: {
        type: { type: "string" },
        name: { type: "string" },
        props: {
          type: "object",
          properties: {
            style: { anyOf: [{ type: "object" }, { type: "string" }] },
          },
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              { type: "undefined" },
              {
                type: "object",
                properties: {},
              },
              {
                type: "array",
                items: { type: "unknown" },
              },
            ],
          },
        },
        children: {
          type: "array",
          items: { $ref: "#/$defs/vdomRenderNode" },
        },
        [UI]: { $ref: "#/$defs/vdomNode" },
      },
      required: ["type", "name"],
    },
    vdomRenderableObject: {
      type: "object",
      properties: {
        [UI]: { $ref: "#/$defs/vdomNode" },
      },
      required: [UI],
    },
  },
  $ref: "#/$defs/vdomRenderNode",
} as const;

export interface RenderOptions {
  watch?: boolean;
  onUpdate?: (html: string) => void;
  start?: boolean;
}

interface RenderPieceManager {
  runtime: { idle(): Promise<unknown> };
}

interface RenderPieceCell {
  asSchema(schema: unknown): RenderPieceMaterializedCell;
}

interface RenderPieceMaterializedCell {
  get(): { [UI]?: unknown } | undefined;
  sink(
    callback: (value: { [UI]?: unknown } | undefined) => void,
  ): () => void;
}

interface RenderPieceController {
  getCell(): RenderPieceCell;
}

export interface RenderPieceDependencies {
  loadManager?: (config: PieceConfig) => Promise<RenderPieceManager>;
  loadPiece?: (
    manager: RenderPieceManager,
    config: PieceConfig,
    start: boolean,
  ) => Promise<RenderPieceController>;
  render?: typeof render;
}

/**
 * Renders a piece's UI to HTML using htmlparser2.
 * Supports both static and reactive rendering with --watch mode.
 */
export async function renderPiece(
  config: PieceConfig,
  options: RenderOptions = {},
  deps: RenderPieceDependencies = {},
): Promise<string | (() => void)> {
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const { document, renderOptions } = mock;
  const renderHtml = deps.render ?? render;

  // 2. Get piece controller to access the Cell
  const start = options.start ?? true;
  const manager = await (deps.loadManager ?? loadManager)(config);
  const piece = deps.loadPiece
    ? await deps.loadPiece(manager, config, start)
    : await new PiecesController(
      manager as Awaited<ReturnType<typeof loadManager>>,
    ).get(
      config.piece,
      start,
      undefined,
      config.pieceScope,
    );
  const cell = piece.getCell().asSchema({
    type: "object",
    properties: {
      [UI]: cliRendererVDOMSchema,
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
    // 4a. Reactive rendering
    let cancelRender = renderHtml(
      container,
      staticValue[UI] as VNode,
      renderOptions,
    ); // FIXME: types

    // 5a. Set up monitoring for changes
    let disposed = false;
    let updateCount = 0;
    let updateVersion = 0;
    const unsubscribe = cell.sink((value) => {
      if (value?.[UI]) {
        const version = ++updateVersion;
        // Wait for all runtime computations to complete
        manager.runtime.idle().then(() => {
          if (disposed || version !== updateVersion) return;
          updateCount++;
          cancelRender();
          cancelRender = renderHtml(
            container,
            value[UI] as VNode,
            renderOptions,
          ); // FIXME: types
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
      disposed = true;
      unsubscribe();
      cancelRender();
    };
  } else {
    // 4b. Static rendering - render once with current value
    const vnode = staticValue[UI];
    renderHtml(container, vnode as VNode, renderOptions); // FIXME: types

    // 5b. Return the rendered HTML
    return container.innerHTML;
  }
}
