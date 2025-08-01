import { property } from "lit/decorators.js";
import { ReactiveElement } from "lit";
import { type Cell, isCell } from "@commontools/runner";
import type { 
  CellDecoratorOptions, 
  CellDecorator,
  CellPropertyMeta,
  InputTimingOptions 
} from "./cell-decorator-types.ts";
import { InputTimingController } from "./input-timing-controller.ts";

/**
 * WeakMap to track Cell subscriptions per element instance
 * Key: ReactiveElement instance
 * Value: Map of property keys to their unsubscribe functions
 */
const cellSubscriptions = new WeakMap<ReactiveElement, Map<PropertyKey, () => void>>();

/**
 * WeakMap to track Cell property metadata per element instance
 * Key: ReactiveElement instance  
 * Value: Map of property keys to their configuration
 */
const cellPropertyMeta = new WeakMap<ReactiveElement, Map<PropertyKey, CellPropertyMeta>>();

/**
 * WeakMap to track input timing controllers per element instance
 * Key: ReactiveElement instance
 * Value: Map of property keys to their timing controllers
 */
const cellTimingControllers = new WeakMap<ReactiveElement, Map<PropertyKey, InputTimingController>>();

/**
 * Custom converter for Cell<T> properties
 * Extracts the value using cell.get() when converting to attribute
 * Does not support fromAttribute conversion (Cells are complex objects)
 */
const cellConverter = {
  /**
   * Cells are complex objects that can't be meaningfully converted from string attributes
   * This should typically not be called since Cell properties shouldn't be reflected
   */
  fromAttribute: (value: string | null) => {
    if (value === null) return undefined;
    // Could potentially support JSON deserialization here if needed
    return undefined;
  },

  /**
   * Convert Cell<T> to attribute value by extracting the cell's current value
   * Returns null if cell is null/undefined or has no value
   */
  toAttribute: <T>(value: Cell<T> | null | undefined): string | null => {
    if (!value || !isCell(value)) return null;
    
    const currentValue = value.get?.();
    if (currentValue === null || currentValue === undefined) return null;
    
    // Convert the cell's current value to string
    if (typeof currentValue === "string") return currentValue;
    if (typeof currentValue === "number" || typeof currentValue === "boolean") {
      return String(currentValue);
    }
    
    // For complex types, use JSON representation
    try {
      return JSON.stringify(currentValue);
    } catch {
      return String(currentValue);
    }
  }
};

/**
 * Custom hasChanged function that compares Cell identity, not values
 * This ensures that changing to a different Cell triggers updates,
 * while changes within the same Cell are handled by subscriptions
 */
const cellHasChanged = <T>(newValue: Cell<T> | undefined, oldValue: Cell<T> | undefined): boolean => {
  // Use identity comparison for Cells - different Cell instances are different properties
  return newValue !== oldValue;
};

/**
 * Set up Cell subscription for a property on an element
 */
function setupCellSubscription(
  element: ReactiveElement,
  propertyKey: PropertyKey,
  cell: Cell<any>
): void {
  // Clean up any existing subscription first
  cleanupCellSubscription(element, propertyKey);
  
  if (!isCell(cell)) return;
  
  // Create subscription map if it doesn't exist
  if (!cellSubscriptions.has(element)) {
    cellSubscriptions.set(element, new Map());
  }
  
  const subscriptions = cellSubscriptions.get(element)!;
  
  try {
    // Subscribe to cell changes and trigger element updates
    const unsubscribe = cell.sink(() => {
      element.requestUpdate();
    });
    
    subscriptions.set(propertyKey, unsubscribe);
  } catch (error) {
    console.error(`Error setting up Cell subscription for property ${String(propertyKey)}:`, error);
  }
}

/**
 * Clean up Cell subscription for a property on an element
 */
function cleanupCellSubscription(
  element: ReactiveElement,
  propertyKey: PropertyKey
): void {
  const subscriptions = cellSubscriptions.get(element);
  if (!subscriptions) return;
  
  const unsubscribe = subscriptions.get(propertyKey);
  if (unsubscribe) {
    unsubscribe();
    subscriptions.delete(propertyKey);
  }
}

/**
 * Clean up all Cell subscriptions for an element
 */
function cleanupAllCellSubscriptions(element: ReactiveElement): void {
  const subscriptions = cellSubscriptions.get(element);
  if (!subscriptions) return;
  
  // Call all unsubscribe functions
  for (const unsubscribe of subscriptions.values()) {
    try {
      unsubscribe();
    } catch (error) {
      console.error('Error during Cell subscription cleanup:', error);
    }
  }
  
  subscriptions.clear();
}

/**
 * Set up timing controller for a property
 */
function setupTimingController(
  element: ReactiveElement,
  propertyKey: PropertyKey,
  timing: InputTimingOptions
): InputTimingController {
  // Create timing controllers map if it doesn't exist
  if (!cellTimingControllers.has(element)) {
    cellTimingControllers.set(element, new Map());
  }
  
  const controllers = cellTimingControllers.get(element)!;
  
  // Remove any existing controller first
  const existingController = controllers.get(propertyKey);
  if (existingController) {
    // Clean up existing controller if it has cleanup methods
    if (typeof existingController.cancel === 'function') {
      existingController.cancel();
    }
  }
  
  // Create new timing controller
  const controller = new InputTimingController(element, timing);
  controllers.set(propertyKey, controller);
  
  return controller;
}

/**
 * Get timing controller for a property
 */
function getTimingController(
  element: ReactiveElement,
  propertyKey: PropertyKey
): InputTimingController | undefined {
  return cellTimingControllers.get(element)?.get(propertyKey);
}

/**
 * Store property metadata for an element
 */
function storeCellPropertyMeta(
  element: ReactiveElement,
  propertyKey: PropertyKey,
  meta: CellPropertyMeta
): void {
  if (!cellPropertyMeta.has(element)) {
    cellPropertyMeta.set(element, new Map());
  }
  
  const metaMap = cellPropertyMeta.get(element)!;
  metaMap.set(propertyKey, meta);
}

/**
 * Get property metadata for an element
 */
function getCellPropertyMeta(
  element: ReactiveElement,
  propertyKey: PropertyKey
): CellPropertyMeta | undefined {
  return cellPropertyMeta.get(element)?.get(propertyKey);
}

/**
 * Enhanced property setter that handles Cell subscription management
 * This is called by Lit when the property value changes
 */
function createCellPropertySetter<T>(propertyKey: PropertyKey) {
  return function(this: ReactiveElement, newValue: Cell<T>) {
    const oldValue = (this as any)[`__${String(propertyKey)}`];
    
    // Store the new value in a private property
    (this as any)[`__${String(propertyKey)}`] = newValue;
    
    // Set up Cell subscription if it's a Cell
    if (isCell(newValue)) {
      setupCellSubscription(this, propertyKey, newValue);
    } else {
      // Clean up subscription if switching from Cell to non-Cell
      cleanupCellSubscription(this, propertyKey);
    }
    
    // Trigger Lit's reactive update cycle
    this.requestUpdate(propertyKey, oldValue);
  };
}

/**
 * Enhanced property getter that retrieves Cell values
 */
function createCellPropertyGetter<T>(propertyKey: PropertyKey) {
  return function(this: ReactiveElement): Cell<T> {
    return (this as any)[`__${String(propertyKey)}`];
  };
}

/**
 * The @cell() decorator for Lit components
 * 
 * This decorator simplifies Cell<T> integration by:
 * 1. Setting up proper property conversion and change detection
 * 2. Managing Cell subscriptions automatically
 * 3. Integrating with input timing controllers for delayed updates
 * 4. Supporting accessor properties with custom getter/setter logic
 * 5. Composing with Lit's @property() decorator
 * 
 * @example
 * ```typescript
 * class MyComponent extends BaseElement {
 *   @cell({ timing: { strategy: "debounce", delay: 300 } })
 *   accessor myValue: Cell<string> | undefined;
 *   
 *   private handleInput(event: Event) {
 *     const input = event.target as HTMLInputElement;
 *     // Set value through timing controller
 *     setCellValue(this, 'myValue', input.value);
 *   }
 * }
 * ```
 */
export const cell: CellDecorator = (options: CellDecoratorOptions = {}) => {
  return (target: any, propertyKey: PropertyKey, descriptor?: PropertyDescriptor) => {
    // Store timing metadata for this property on the constructor
    const ctor = target.constructor;
    if (!ctor.__cellMeta) {
      ctor.__cellMeta = new Map();
    }
    
    const meta: CellPropertyMeta = {
      propertyKey,
      timing: options.timing,
      isCellProperty: true,
    };
    ctor.__cellMeta.set(propertyKey, meta);
    
    // For accessor properties (standard decorators)
    if (descriptor && (descriptor.get || descriptor.set)) {
      const originalGetter = descriptor.get;
      const originalSetter = descriptor.set;
      
      // Create enhanced getter that handles Cell subscriptions
      descriptor.get = function(this: ReactiveElement) {
        const value = originalGetter?.call(this);
        
        // Set up subscription if this is a Cell and we haven't seen it before
        if (isCell(value)) {
          const currentSubscriptions = cellSubscriptions.get(this);
          if (!currentSubscriptions?.has(propertyKey)) {
            setupCellSubscription(this, propertyKey, value);
          }
        }
        
        return value;
      };
      
      // Create enhanced setter that manages subscriptions
      descriptor.set = function(this: ReactiveElement, newValue: any) {
        const oldValue = originalGetter?.call(this);
        
        // Call original setter
        originalSetter?.call(this, newValue);
        
        // Manage Cell subscriptions
        if (isCell(newValue)) {
          setupCellSubscription(this, propertyKey, newValue);
        } else {
          cleanupCellSubscription(this, propertyKey);
        }
        
        // Store metadata on element instance
        storeCellPropertyMeta(this, propertyKey, meta);
        
        // Set up timing controller if needed
        if (meta.timing) {
          setupTimingController(this, propertyKey, meta.timing);
        }
        
        // Trigger update if value changed
        if (cellHasChanged(newValue, oldValue)) {
          this.requestUpdate(propertyKey, oldValue);
        }
      };
      
      return descriptor;
    }
    
    // For class fields (experimental decorators), delegate to @property
    // This provides fallback compatibility
    const propertyDecorator = property({
      // Inherit base property options
      ...options,
      
      // Cell-specific converter
      converter: cellConverter,
      
      // Cell-specific change detection
      hasChanged: cellHasChanged,
      
      // Cells typically shouldn't be reflected to attributes by default
      // (can be overridden in options)
      attribute: options.attribute ?? false,
    });
    
    return propertyDecorator(target, propertyKey, descriptor);
  };
};

/**
 * Hook into Lit's lifecycle to manage Cell subscriptions and metadata
 * This extends ReactiveElement to add Cell-specific setup and cleanup
 */
const originalConnectedCallback = ReactiveElement.prototype.connectedCallback;
const originalDisconnectedCallback = ReactiveElement.prototype.disconnectedCallback;

ReactiveElement.prototype.connectedCallback = function() {
  // Initialize Cell metadata from constructor if available
  const ctor = this.constructor as any;
  if (ctor.__cellMeta) {
    for (const [propertyKey, meta] of ctor.__cellMeta.entries()) {
      storeCellPropertyMeta(this, propertyKey, meta);
      
      // Set up timing controller if needed
      if (meta.timing) {
        setupTimingController(this, propertyKey, meta.timing);
      }
    }
  }
  
  // Call original connectedCallback
  originalConnectedCallback?.call(this);
};

ReactiveElement.prototype.disconnectedCallback = function() {
  // Clean up all Cell subscriptions
  cleanupAllCellSubscriptions(this);
  
  // Clean up timing controllers
  const controllers = cellTimingControllers.get(this);
  if (controllers) {
    for (const controller of controllers.values()) {
      if (typeof controller.cancel === 'function') {
        controller.cancel();
      }
    }
    controllers.clear();
  }
  
  // Call original disconnectedCallback
  originalDisconnectedCallback?.call(this);
};

/**
 * Extract the current value from a Cell property
 * Returns undefined if the property is not a Cell or has no value
 * 
 * @param element - The component instance
 * @param propertyKey - The property key (string or symbol)
 * @returns The current value of the Cell, or undefined
 */
export function getCellValue<T>(
  element: ReactiveElement,
  propertyKey: PropertyKey
): T | undefined {
  const cell = (element as any)[propertyKey] as Cell<T>;
  if (!isCell(cell)) {
    return undefined;
  }
  
  try {
    return cell.get();
  } catch (error) {
    console.warn(`Error getting value from Cell property ${String(propertyKey)}:`, error);
    return undefined;
  }
}

/**
 * Helper for immutable updates to Cell properties (like ct-list uses)
 * Executes a mutator function within a transaction
 * 
 * @param element - The component instance
 * @param propertyKey - The property key (string or symbol) 
 * @param mutator - Function that performs the mutation on the Cell
 */
export function mutateCell<T>(
  element: ReactiveElement,
  propertyKey: PropertyKey,
  mutator: (value: Cell<T>) => void
): void {
  const cell = (element as any)[propertyKey] as Cell<T>;
  if (!isCell(cell)) {
    console.warn(`Property ${String(propertyKey)} is not a Cell`);
    return;
  }
  
  try {
    const tx = cell.runtime.edit();
    mutator(cell.withTx(tx));
    tx.commit();
  } catch (error) {
    console.error(`Error mutating Cell property ${String(propertyKey)}:`, error);
  }
}

/**
 * Utility function for components to set Cell values with timing control
 * This should be used by components instead of directly calling cell.set()
 * 
 * @param element - The component instance
 * @param propertyKey - The property key (string or symbol)
 * @param newValue - The new value to set
 */
export function setCellValue<T>(
  element: ReactiveElement,
  propertyKey: PropertyKey,
  newValue: T
): void {
  const cell = (element as any)[propertyKey] as Cell<T>;
  if (!isCell(cell)) {
    console.warn(`Property ${String(propertyKey)} is not a Cell`);
    return;
  }
  
  const meta = getCellPropertyMeta(element, propertyKey);
  if (!meta?.timing) {
    // No timing control, set immediately
    try {
      const tx = cell.runtime.edit();
      cell.withTx(tx).set(newValue);
      tx.commit();
    } catch (error) {
      console.error(`Error setting Cell property ${String(propertyKey)}:`, error);
    }
    return;
  }
  
  // Get or create timing controller
  let timingController = getTimingController(element, propertyKey);
  if (!timingController) {
    timingController = setupTimingController(element, propertyKey, meta.timing);
  }
  
  // Schedule the cell update
  timingController.schedule(() => {
    try {
      const tx = cell.runtime.edit();
      cell.withTx(tx).set(newValue);
      tx.commit();
    } catch (error) {
      console.error(`Error setting Cell property ${String(propertyKey)} via timing controller:`, error);
    }
  });
}

/**
 * Notify the timing controller that a Cell property's input has gained focus
 * This is required for blur timing strategy to work properly
 * 
 * @param element - The component instance
 * @param propertyKey - The property key (string or symbol)
 */
export function notifyCellFocus(
  element: ReactiveElement,
  propertyKey: PropertyKey
): void {
  const timingController = getTimingController(element, propertyKey);
  if (timingController && typeof timingController.onFocus === 'function') {
    timingController.onFocus();
  }
}

/**
 * Notify the timing controller that a Cell property's input has lost focus
 * This is required for blur timing strategy to work properly
 * 
 * @param element - The component instance
 * @param propertyKey - The property key (string or symbol)
 */
export function notifyCellBlur(
  element: ReactiveElement,
  propertyKey: PropertyKey
): void {
  const timingController = getTimingController(element, propertyKey);
  if (timingController && typeof timingController.onBlur === 'function') {
    timingController.onBlur();
  }
}