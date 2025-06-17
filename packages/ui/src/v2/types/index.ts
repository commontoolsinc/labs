/**
 * Type Definitions Index
 *
 * Central export point for all type definitions
 */

// Additional utility types
export type ElementConstructor<T = HTMLElement> = new (...args: any[]) => T;

export interface CustomElementConfig {
  tagName: string;
  constructor: ElementConstructor;
}

// Helper type for extracting props from element
export type ExtractProps<T> = T extends new (...args: any[]) => infer E
  ? E extends HTMLElement ? Partial<Omit<E, keyof HTMLElement>>
  : never
  : never;
