/**
 * Common type definitions for web components
 */

/**
 * Constructor type for custom elements
 */
export type CustomElementConstructor = new (...args: any[]) => HTMLElement;

/**
 * Component registration options
 */
export interface ComponentOptions {
  tagName: string;
  constructor: CustomElementConstructor;
}

/**
 * Event detail types
 */
export interface ComponentEvent<T = any> extends CustomEvent<T> {
  readonly detail: T;
}

/**
 * Common component properties
 */
export interface ComponentProps {
  id?: string;
  class?: string;
  style?: string;
}

/**
 * Size variants
 */
export type Size = "small" | "medium" | "large";

/**
 * Color variants
 */
export type Variant =
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "error"
  | "info";

/**
 * Component state
 */
export interface ComponentState {
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
}
