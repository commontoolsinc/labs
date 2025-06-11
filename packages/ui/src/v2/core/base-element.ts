/**
 * Minimal base class for web components using Lit
 * Provides the emit() helper for consistent custom events
 */
import { css, CSSResult, LitElement } from "lit";
import { variablesCSS } from "../styles/variables.ts";

export abstract class BaseElement extends LitElement {
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
