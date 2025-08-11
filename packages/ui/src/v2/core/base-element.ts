/**
 * Minimal base class for web components using Lit
 * Provides the emit() helper for consistent custom events
 */
import { css, CSSResult, LitElement } from "lit";
import { variablesCSS } from "../styles/variables.ts";
import { DebugController } from "./debug-controller.ts";

// Set to `true` to render outlines everytime a
// LitElement renders.
const DEBUG_RENDERER = false;

export abstract class BaseElement extends LitElement {
  // deno-lint-ignore no-unused-vars
  #debugController = new DebugController(this, DEBUG_RENDERER);

  /**
   * Get base styles including CSS variables
   */
  static get baseStyles(): CSSResult {
    // Create CSS with variables for the host element
    const hostStyles = `:host { ${variablesCSS} }`;
    return css([hostStyles] as any);
  }

  /**
   * Dispatch a custom event with common defaults
   */
  protected emit<T = any>(
    eventName: string,
    detail?: T,
    options?: EventInit,
  ): boolean {
    const event = new CustomEvent(eventName, {
      detail,
      bubbles: true,
      composed: true,
      ...options,
    });
    return this.dispatchEvent(event);
  }
}
