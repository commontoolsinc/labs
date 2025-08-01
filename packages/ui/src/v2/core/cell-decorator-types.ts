import type { PropertyDeclaration } from "lit";
import type { InputTimingOptions } from "./input-timing-controller.ts";

/**
 * Configuration options for the @cell() decorator
 * Extends Lit's PropertyDeclaration with Cell-specific options
 */
export interface CellDecoratorOptions extends PropertyDeclaration {
  /**
   * Input timing strategy configuration for Cell updates
   * Controls when Cell.set() is called (immediate, debounce, throttle, blur)
   */
  timing?: InputTimingOptions;
}

/**
 * Type signature for the @cell() decorator function
 * 
 * This decorator is designed to work ONLY with Cell<T> properties,
 * not Cell<T> | T unions. This simplifies the implementation significantly.
 * 
 * @example
 * ```typescript
 * class MyComponent extends BaseElement {
 *   @cell({ timing: { strategy: "debounce", delay: 300 } })
 *   accessor myValue: Cell<string>;
 * }
 * ```
 */
export interface CellDecorator {
  /**
   * @cell() decorator with options
   */
  (options?: CellDecoratorOptions): PropertyDecorator;
  
  /**
   * @cell() decorator without options (using defaults)
   */
  (): PropertyDecorator;
}

/**
 * Internal type for tracking property metadata
 * Used by the decorator implementation to store configuration
 */
export interface CellPropertyMeta {
  /** Property key on the element */
  propertyKey: PropertyKey;
  
  /** Timing options for this property */
  timing?: InputTimingOptions;
  
  /** Whether this property has been configured for Cell management */
  isCellProperty: true;
}

/**
 * Re-export timing types for convenience
 */
export type {
  InputTimingOptions,
  InputTimingStrategy,
} from "./input-timing-controller.ts";