/**
 * Main-thread DOM applicator.
 *
 * This module receives VDomOp batches from the worker thread and applies
 * them to the actual DOM. It maintains a mapping from node IDs to DOM nodes
 * and handles bidirectional bindings and event dispatch.
 */

import type {
  CellRef,
  DomEventMessage,
  RuntimeClient,
  VDomBatch,
  VDomOp,
} from "@commontools/runtime-client";
import { serializeEvent } from "@commontools/runtime-client/vdom-worker/events";
import { CellHandle } from "@commontools/runtime-client";
import { setPropDefault, type SetPropHandler } from "../render-utils.ts";

/**
 * Reserved node ID for the container element.
 * Must match the value in worker/reconciler.ts.
 */
export const CONTAINER_NODE_ID = 0;

/**
 * Options for creating a DOM applicator.
 */
export interface DomApplicatorOptions {
  /** The document to create elements in */
  document?: Document;

  /** Callback when a DOM event needs to be sent back to the worker */
  onEvent: (message: DomEventMessage) => void;

  /** RuntimeClient for creating CellHandles from CellRefs */
  runtimeClient: RuntimeClient;

  /** Optional callback for errors */
  onError?: (error: Error) => void;

  /** Optional custom property setter */
  setProp?: SetPropHandler;
}

/**
 * DOM applicator that applies VDomOps to the real DOM.
 */
export class DomApplicator {
  private readonly nodes = new Map<number, Node>();
  private readonly eventListeners = new Map<
    number,
    Map<string, EventListener>
  >();
  private readonly document: Document;
  private readonly onEvent: (message: DomEventMessage) => void;
  private readonly runtimeClient: RuntimeClient;
  private readonly onError?: (error: Error) => void;
  private readonly setPropHandler: SetPropHandler;

  private rootNodeId: number | null = null;

  constructor(options: DomApplicatorOptions) {
    this.document = options.document ?? globalThis.document;
    this.onEvent = options.onEvent;
    this.runtimeClient = options.runtimeClient;
    this.onError = options.onError;
    this.setPropHandler = options.setProp ?? setPropDefault;
  }

  /**
   * Apply a batch of VDOM operations.
   */
  applyBatch(batch: VDomBatch): void {
    for (const op of batch.ops) {
      try {
        this.applyOp(op);
      } catch (error) {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    if (batch.rootId !== undefined) {
      this.rootNodeId = batch.rootId;
    }
  }

  /**
   * Apply a single VDOM operation.
   */
  private applyOp(op: VDomOp): void {
    switch (op.op) {
      case "create-element":
        this.createElement(op.nodeId, op.tagName);
        break;

      case "create-text":
        this.createText(op.nodeId, op.text);
        break;

      case "update-text":
        this.updateText(op.nodeId, op.text);
        break;

      case "set-prop":
        this.setProp(op.nodeId, op.key, op.value);
        break;

      case "remove-prop":
        this.removeProp(op.nodeId, op.key);
        break;

      case "set-event":
        this.setEvent(op.nodeId, op.eventType, op.handlerId);
        break;

      case "remove-event":
        this.removeEvent(op.nodeId, op.eventType);
        break;

      case "set-binding":
        this.setBinding(op.nodeId, op.propName, op.cellRef);
        break;

      case "insert-child":
        this.insertChild(op.parentId, op.childId, op.beforeId);
        break;

      case "move-child":
        this.moveChild(op.parentId, op.childId, op.beforeId);
        break;

      case "remove-node":
        this.removeNode(op.nodeId);
        break;

      case "set-attrs":
        this.setAttrs(op.nodeId, op.attrs);
        break;
    }
  }

  /**
   * Get the root DOM node.
   */
  getRootNode(): Node | null {
    return this.rootNodeId !== null
      ? this.nodes.get(this.rootNodeId) ?? null
      : null;
  }

  /**
   * Get a DOM node by ID.
   */
  getNode(nodeId: number): Node | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Register the container element.
   * The container is where rendered content will be inserted.
   * Must be called before applying any batches.
   */
  setContainer(container: HTMLElement): void {
    this.nodes.set(CONTAINER_NODE_ID, container);
  }

  /**
   * Mount the rendered tree into a parent element.
   * @deprecated Use setContainer instead - content is now inserted directly.
   */
  mountInto(parent: HTMLElement, rootId: number): void {
    const root = this.nodes.get(rootId);
    if (root) {
      parent.appendChild(root);
    }
  }

  /**
   * Dispose of all tracked nodes and listeners.
   */
  dispose(): void {
    // Remove all event listeners (skip container)
    for (const [nodeId, listeners] of this.eventListeners) {
      if (nodeId === CONTAINER_NODE_ID) continue;
      const node = this.nodes.get(nodeId);
      if (node) {
        for (const [eventType, listener] of listeners) {
          (node as EventTarget).removeEventListener(eventType, listener);
        }
      }
    }
    this.eventListeners.clear();

    // Remove all nodes except the container (it's owned by the caller)
    for (const [nodeId, node] of this.nodes) {
      if (nodeId === CONTAINER_NODE_ID) continue;
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }
    this.nodes.clear();
    this.rootNodeId = null;
  }

  // ============== Operation Implementations ==============

  private createElement(nodeId: number, tagName: string): void {
    const element = this.document.createElement(tagName);
    this.nodes.set(nodeId, element);
  }

  private createText(nodeId: number, text: string): void {
    const textNode = this.document.createTextNode(text);
    this.nodes.set(nodeId, textNode);
  }

  private updateText(nodeId: number, text: string): void {
    const node = this.nodes.get(nodeId);
    if (node && node.nodeType === Node.TEXT_NODE) {
      node.textContent = text;
    }
  }

  private setProp(nodeId: number, key: string, value: unknown): void {
    const node = this.nodes.get(nodeId);
    if (!(node instanceof HTMLElement)) return;

    // Use the configured property setter (defaults to setPropDefault)
    this.setPropHandler(node, key, value);
  }

  private removeProp(nodeId: number, key: string): void {
    const node = this.nodes.get(nodeId);
    if (!(node instanceof HTMLElement)) return;

    if (key.startsWith("data-")) {
      node.removeAttribute(key);
    } else if (key === "style") {
      node.removeAttribute("style");
    } else {
      (node as any)[key] = undefined;
    }
  }

  private setEvent(nodeId: number, eventType: string, handlerId: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Remove existing listener for this event type
    this.removeEvent(nodeId, eventType);

    // Create new listener
    const listener: EventListener = (event: Event) => {
      const serialized = serializeEvent(event);
      const message: DomEventMessage = {
        type: "dom-event",
        handlerId,
        event: serialized,
        nodeId,
      };
      this.onEvent(message);
    };

    // Track listener
    let listeners = this.eventListeners.get(nodeId);
    if (!listeners) {
      listeners = new Map();
      this.eventListeners.set(nodeId, listeners);
    }
    listeners.set(eventType, listener);

    // Add to DOM
    (node as EventTarget).addEventListener(eventType, listener);
  }

  private removeEvent(nodeId: number, eventType: string): void {
    const listeners = this.eventListeners.get(nodeId);
    if (!listeners) return;

    const listener = listeners.get(eventType);
    if (!listener) return;

    const node = this.nodes.get(nodeId);
    if (node) {
      (node as EventTarget).removeEventListener(eventType, listener);
    }
    listeners.delete(eventType);
  }

  private setBinding(nodeId: number, propName: string, cellRef: CellRef): void {
    const node = this.nodes.get(nodeId);
    if (!(node instanceof HTMLElement)) return;

    // Create a CellHandle from the CellRef
    const cellHandle = new CellHandle(this.runtimeClient, cellRef);

    // Set the CellHandle on the element's property
    // Custom elements like ct-input and ct-checkbox expect this
    (node as any)[propName] = cellHandle;
  }

  private insertChild(
    parentId: number,
    childId: number,
    beforeId: number | null,
  ): void {
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (!parent || !child) return;

    const beforeNode = beforeId !== null
      ? this.nodes.get(beforeId) ?? null
      : null;

    if (beforeNode && beforeNode.parentNode === parent) {
      // Only use insertBefore if the beforeNode is actually a child of parent
      parent.insertBefore(child, beforeNode);
    } else {
      // Either no beforeNode, or it's not a child of this parent - just append
      parent.appendChild(child);
    }
  }

  private moveChild(
    parentId: number,
    childId: number,
    beforeId: number | null,
  ): void {
    // Move is the same as insert - insertBefore handles it
    this.insertChild(parentId, childId, beforeId);
  }

  private removeNode(nodeId: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Remove event listeners
    const listeners = this.eventListeners.get(nodeId);
    if (listeners) {
      for (const [eventType, listener] of listeners) {
        (node as EventTarget).removeEventListener(eventType, listener);
      }
      this.eventListeners.delete(nodeId);
    }

    // Remove from DOM
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }

    // Remove from tracking
    this.nodes.delete(nodeId);
  }

  private setAttrs(nodeId: number, attrs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attrs)) {
      this.setProp(nodeId, key, value);
    }
  }
}

/**
 * Create a new DOM applicator.
 */
export function createDomApplicator(
  options: DomApplicatorOptions,
): DomApplicator {
  return new DomApplicator(options);
}
