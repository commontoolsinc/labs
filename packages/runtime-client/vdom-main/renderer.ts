/**
 * Main-thread VDOM renderer.
 *
 * This class integrates the DomApplicator with the RuntimeConnection,
 * handling VDomBatch notifications from the worker and sending DOM events
 * back to the worker.
 */

import type { RuntimeConnection } from "../client/connection.ts";
import type { RuntimeClient } from "../runtime-client.ts";
import type { CellRef, VDomBatchNotification } from "../protocol/mod.ts";
import { DomApplicator } from "./applicator.ts";
import type { DomEventMessage } from "../vdom-worker/events.ts";

// Global mount ID counter
let nextMountId = 1;

/**
 * Options for creating a VDomRenderer.
 */
export interface VDomRendererOptions {
  /** The RuntimeClient for creating CellHandles */
  runtimeClient: RuntimeClient;

  /** The RuntimeConnection for IPC */
  connection: RuntimeConnection;

  /** The document to render into */
  document?: Document;

  /** Optional error handler */
  onError?: (error: Error) => void;
}

/**
 * VDOM renderer that bridges the worker reconciler and main-thread DOM.
 *
 * Usage:
 * ```ts
 * const renderer = new VDomRenderer({
 *   runtimeClient,
 *   connection,
 * });
 *
 * // Mount a cell into a container - returns a cancel function
 * const cancel = await renderer.render(containerElement, cellRef);
 *
 * // Later, to stop rendering:
 * cancel();
 * ```
 */
export class VDomRenderer {
  private readonly applicator: DomApplicator;
  private readonly connection: RuntimeConnection;
  private readonly onError?: (error: Error) => void;

  private mountId: number | null = null;
  private containerElement: HTMLElement | null = null;
  private rootNodeId: number | null = null;
  private disposed = false;

  constructor(options: VDomRendererOptions) {
    this.connection = options.connection;
    this.onError = options.onError;

    // Create the DOM applicator
    this.applicator = new DomApplicator({
      document: options.document,
      runtimeClient: options.runtimeClient,
      onEvent: (message) => this.handleDomEvent(message),
      onError: options.onError,
    });

    // Subscribe to VDomBatch notifications
    this.connection.on("vdombatch", this.handleVDomBatch);
  }

  /**
   * Start rendering a cell into a container element.
   *
   * @param container - The DOM element to render into
   * @param cellRef - The cell reference to render
   * @returns A cancel function to stop rendering
   */
  async render(
    container: HTMLElement,
    cellRef: CellRef,
  ): Promise<() => Promise<void>> {
    if (this.mountId !== null) {
      throw new Error(
        "VDomRenderer already has an active mount. Call cancel first.",
      );
    }

    this.containerElement = container;
    this.mountId = nextMountId++;

    // Request the worker to start rendering
    const response = await this.connection.mountVDom(this.mountId, cellRef);
    this.rootNodeId = response.rootId;

    // Return a cancel function
    return async () => {
      await this.stopRendering();
    };
  }

  /**
   * Stop rendering and clean up.
   */
  async stopRendering(): Promise<void> {
    if (this.mountId === null) {
      return;
    }

    const mountId = this.mountId;
    this.mountId = null;

    // Request the worker to stop rendering
    await this.connection.unmountVDom(mountId);

    // Remove the root node from DOM
    if (this.rootNodeId !== null) {
      const rootNode = this.applicator.getNode(this.rootNodeId);
      if (rootNode?.parentNode) {
        rootNode.parentNode.removeChild(rootNode);
      }
      this.rootNodeId = null;
    }

    this.containerElement = null;
  }

  /**
   * Dispose of the renderer and clean up all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    await this.stopRendering();
    this.connection.off("vdombatch", this.handleVDomBatch);
    this.applicator.dispose();
  }

  /**
   * Get the root DOM node if available.
   */
  getRootNode(): Node | null {
    return this.rootNodeId !== null
      ? this.applicator.getNode(this.rootNodeId) ?? null
      : null;
  }

  // ============== Private Methods ==============

  private handleVDomBatch = (notification: VDomBatchNotification): void => {
    if (this.disposed) return;

    // Filter for our mount ID
    if (
      notification.mountId !== undefined &&
      notification.mountId !== this.mountId
    ) {
      return;
    }

    try {
      // Apply the batch to the DOM
      this.applicator.applyBatch({
        batchId: notification.batchId,
        ops: notification.ops,
        rootId: notification.rootId,
      });

      // Track root node ID if provided
      if (notification.rootId !== undefined) {
        const isNewRoot = this.rootNodeId !== notification.rootId;
        this.rootNodeId = notification.rootId;

        // If we have a container and this is a new root, mount it
        if (isNewRoot && this.containerElement) {
          this.applicator.mountInto(this.containerElement, this.rootNodeId);
        }
      }
    } catch (error) {
      this.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  private handleDomEvent(message: DomEventMessage): void {
    if (this.disposed) return;

    // Send the event to the worker via the connection
    this.connection.sendVDomEvent(
      message.handlerId,
      message.event,
      message.nodeId,
    );
  }
}

/**
 * Create a new VDomRenderer.
 */
export function createVDomRenderer(options: VDomRendererOptions): VDomRenderer {
  return new VDomRenderer(options);
}

/**
 * Convenience function to render a cell into a container.
 * Returns a cancel function to stop rendering.
 *
 * @param container - The DOM element to render into
 * @param cellRef - The cell reference to render
 * @param options - Renderer options
 * @returns A cancel function
 */
export async function renderVDom(
  container: HTMLElement,
  cellRef: CellRef,
  options: VDomRendererOptions,
): Promise<() => Promise<void>> {
  const renderer = createVDomRenderer(options);
  const cancel = await renderer.render(container, cellRef);

  // Return a cancel function that also disposes the renderer
  return async () => {
    await cancel();
    await renderer.dispose();
  };
}
