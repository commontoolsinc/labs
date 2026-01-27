/**
 * Main-thread VDOM module.
 *
 * This module provides the main-thread implementation of the VDOM system,
 * which receives VDOM operations from the worker thread and applies them
 * to the actual DOM.
 */

// Applicator
export type { DomApplicatorOptions } from "./applicator.ts";
export { createDomApplicator, DomApplicator } from "./applicator.ts";

// Renderer
export type { VDomRendererOptions } from "./renderer.ts";
export { createVDomRenderer, VDomRenderer } from "./renderer.ts";
