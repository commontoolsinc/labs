/**
 * Main-thread VDOM module.
 *
 * This module provides the DOM applicator and renderer for applying
 * VDomOp operations from the worker thread to the actual DOM.
 */

export { createDomApplicator, DomApplicator } from "./applicator.ts";
export type { DomApplicatorOptions } from "./applicator.ts";

export { createVDomRenderer, renderVDom, VDomRenderer } from "./renderer.ts";
export type { VDomRendererOptions } from "./renderer.ts";

export {
  ALLOWLISTED_EVENT_PROPERTIES,
  ALLOWLISTED_TARGET_PROPERTIES,
  isDomEventMessage,
  serializeEvent,
} from "./events.ts";
export type {
  DomEventMessage,
  SerializedEvent,
  SerializedEventTarget,
} from "./events.ts";
