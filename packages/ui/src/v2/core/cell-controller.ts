import { ReactiveController, ReactiveControllerHost } from "lit";
import { type Cell, isCell } from "@commontools/runner";
import {
  InputTimingController,
  type InputTimingOptions,
} from "./input-timing-controller.ts";

/**
 * Configuration options for CellController
 */
export interface CellControllerOptions<T> {
  /**
   * Input timing strategy configuration
   */
  timing?: InputTimingOptions;

  /**
   * Custom getter function for extracting values from Cell<T> | T
   * Defaults to standard Cell.get() or direct value access
   */
  getValue?: (value: Cell<T> | T) => Readonly<T>;

  /**
   * Custom setter function for updating Cell<T> | T values
   * Defaults to standard transaction-based Cell.set() or direct assignment
   */
  setValue?: (value: Cell<T> | T, newValue: T, oldValue: T) => void;

  /**
   * Custom change handler called when value changes
   * Use this for component-specific logic like custom events or validation
   */
  onChange?: (newValue: T, oldValue: T) => void;

  /**
   * Custom transaction strategy
   * - "auto" (default): Create transaction, set value, commit immediately
   * - "manual": Only call setValue, let caller handle transactions
   * - "batch": Collect changes and commit in batches (advanced usage)
   */
  transactionStrategy?: "auto" | "manual" | "batch";

  /**
   * Whether to trigger host.requestUpdate() on Cell changes
   * Defaults to true
   */
  triggerUpdate?: boolean;

  /**
   * Custom focus/blur handlers for timing integration
   */
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * A reactive controller that manages Cell<T> | T integration for Lit components.
 * Handles subscription lifecycle, transaction management, and timing strategies.
 *
 * This controller eliminates boilerplate code by providing a unified interface
 * for components that need to work with both plain values and reactive Cells.
 *
 * @example Basic usage:
 * ```typescript
 * class MyComponent extends BaseElement {
 *   @property() value: Cell<string> | string = "";
 *
 *   private cellController = new CellController<string>(this, {
 *     timing: { strategy: "debounce", delay: 300 },
 *     onChange: (newValue, oldValue) => {
 *       this.emit("value-changed", { value: newValue, oldValue });
 *     }
 *   });
 *
 *   private handleInput(event: Event) {
 *     const input = event.target as HTMLInputElement;
 *     this.cellController.setValue(input.value);
 *   }
 *
 *   override render() {
 *     return html`<input .value="${this.cellController.getValue()}" @input="${this.handleInput}">`;
 *   }
 * }
 * ```
 *
 * @example With timing controller integration:
 * ```typescript
 * class MyInput extends BaseElement {
 *   private cellController = new CellController<string>(this, {
 *     timing: { strategy: "blur" },
 *     onFocus: () => this.classList.add("focused"),
 *     onBlur: () => this.classList.remove("focused")
 *   });
 *
 *   private handleFocus() {
 *     this.cellController.onFocus();
 *   }
 *
 *   private handleBlur() {
 *     this.cellController.onBlur();
 *   }
 * }
 * ```
 */
export class CellController<T> implements ReactiveController {
  private host: ReactiveControllerHost;
  private options: Required<CellControllerOptions<T>>;
  private _currentValue: Cell<T> | T | undefined;
  private _cellUnsubscribe: (() => void) | null = null;
  private _inputTiming?: InputTimingController;

  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<T> = {},
  ) {
    this.host = host;
    this.options = {
      timing: options.timing || { strategy: "debounce", delay: 300 },
      getValue: options.getValue || this.defaultGetValue.bind(this),
      setValue: options.setValue || this.defaultSetValue.bind(this),
      onChange: options.onChange || (() => {}),
      transactionStrategy: options.transactionStrategy || "auto",
      triggerUpdate: options.triggerUpdate ?? true,
      onFocus: options.onFocus || (() => {}),
      onBlur: options.onBlur || (() => {}),
    };

    // Create timing controller if timing options are provided
    if (this.options.timing) {
      this._inputTiming = new InputTimingController(host, this.options.timing);
    }

    host.addController(this);
  }

  /**
   * Set the current value reference and set up subscriptions
   */
  bind(value: Cell<T> | T): void {
    if (this._currentValue !== value) {
      this._cleanupCellSubscription();
      this._currentValue = value;
      this._setupCellSubscription();
    }
  }

  /**
   * Get the current value from Cell<T> | T
   */
  getValue(): Readonly<T> {
    if (this._currentValue === undefined || this._currentValue === null) {
      return undefined as T;
    }
    return this.options.getValue(this._currentValue);
  }

  /**
   * Set a new value, handling timing and transactions
   */
  setValue(newValue: T): void {
    if (this._currentValue === undefined || this._currentValue === null) return;

    const oldValue = this.getValue();

    const performUpdate = () => {
      if (this.options.transactionStrategy === "auto") {
        this.options.setValue(this._currentValue!, newValue, oldValue);
      } else {
        // For manual/batch strategies, just call setValue without transaction handling
        this.options.setValue(this._currentValue!, newValue, oldValue);
      }

      // Call custom change handler
      this.options.onChange(newValue, oldValue);
    };

    // Use timing controller if available
    if (this._inputTiming) {
      this._inputTiming.schedule(performUpdate);
    } else {
      performUpdate();
    }
  }

  /**
   * Update timing controller options
   */
  updateTimingOptions(timingOptions: Partial<InputTimingOptions>): void {
    if (this._inputTiming) {
      this._inputTiming.updateOptions(timingOptions);
    }
    this.options.timing = { ...this.options.timing, ...timingOptions };
  }

  /**
   * Notify timing controller of focus event
   */
  onFocus(): void {
    this._inputTiming?.onFocus();
    this.options.onFocus();
  }

  /**
   * Notify timing controller of blur event
   */
  onBlur(): void {
    this._inputTiming?.onBlur();
    this.options.onBlur();
  }

  /**
   * Cancel any pending operations
   */
  cancel(): void {
    this._inputTiming?.cancel();
  }

  /**
   * Check if current value is a Cell
   */
  isCell(): boolean {
    return isCell(this._currentValue);
  }

  /**
   * Get the underlying Cell (if applicable)
   */
  getCell(): Cell<T> | null {
    return isCell(this._currentValue) ? this._currentValue : null;
  }

  // ReactiveController implementation
  hostConnected(): void {
    this._setupCellSubscription();
  }

  hostDisconnected(): void {
    this._cleanupCellSubscription();
    this._inputTiming?.cancel();
  }

  hostUpdated(): void {
    // Override in subclasses if needed
  }

  // Private methods
  private defaultGetValue(value: Cell<T> | T): T {
    if (isCell(value)) {
      return value.get?.() || (undefined as T);
    }
    return value || (undefined as T);
  }

  private defaultSetValue(value: Cell<T> | T, newValue: T, _oldValue: T): void {
    if (isCell(value)) {
      const tx = value.runtime.edit();
      value.withTx(tx).set(newValue);
      tx.commit();
    } else {
      // For non-Cell values, we can't directly modify them
      // This should be handled by the component's property system
      // The caller should update their property and trigger re-render
    }
  }

  private _setupCellSubscription(): void {
    if (isCell(this._currentValue)) {
      this._cellUnsubscribe = this._currentValue.sink(() => {
        if (this.options.triggerUpdate) {
          this.host.requestUpdate();
        }
      });
    }
  }

  private _cleanupCellSubscription(): void {
    if (this._cellUnsubscribe) {
      this._cellUnsubscribe();
      this._cellUnsubscribe = null;
    }
  }
}

/**
 * Specialized CellController for string values with common input patterns
 */
export class StringCellController extends CellController<string> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<string> = {},
  ) {
    super(host, {
      timing: { strategy: "debounce", delay: 300 },
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCell(value)) {
          return value.get?.() || "";
        }
        // Handle empty strings explicitly - don't treat them as falsy
        return value === undefined || value === null ? "" : value;
      }),
    });
  }
}

/**
 * Specialized CellController for boolean values with common checkbox patterns
 */
export class BooleanCellController extends CellController<boolean> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<boolean> = {},
  ) {
    super(host, {
      timing: { strategy: "immediate" }, // Booleans usually update immediately
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCell(value)) {
          return value.get?.() || false;
        }
        return value || false;
      }),
    });
  }

  /**
   * Toggle the boolean value
   */
  toggle(): void {
    this.setValue(!this.getValue());
  }
}

/**
 * Specialized CellController for array values with common list patterns
 */
export class ArrayCellController<T> extends CellController<T[]> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<T[]> = {},
  ) {
    super(host, {
      timing: { strategy: "immediate" }, // Arrays usually update immediately
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCell(value)) {
          return value.get?.() || [];
        }
        return value || [];
      }),
    });
  }

  /**
   * Add an item to the array
   */
  addItem(item: T): void {
    if (this.isCell()) {
      // Use Cell's native push method for efficient array mutation
      // Must wrap in transaction like other Cell operations
      const cell = this.getCell()!;
      const tx = cell.runtime.edit();
      cell.withTx(tx).push(item);
      tx.commit();
    } else {
      // Fallback for plain arrays
      const currentArray = this.getValue();
      this.setValue([...currentArray, item]);
    }
  }

  /**
   * Remove an item from the array
   * Note: Cell doesn't have native remove/splice methods, so we use filter + setValue
   */
  removeItem(itemToRemove: T): void {
    const currentArray = this.getValue();
    this.setValue(currentArray.filter((item) => item !== itemToRemove));
  }

  /**
   * Update an item in the array
   */
  updateItem(oldItem: T, newItem: T): void {
    const currentArray = this.getValue();
    const index = currentArray.indexOf(oldItem);
    if (index !== -1) {
      if (this.isCell()) {
        // Use Cell's native key() method for direct element mutation
        // Must wrap in transaction like other Cell operations
        const cell = this.getCell()!;
        const tx = cell.runtime.edit();
        cell.withTx(tx).key(index).set(newItem);
        tx.commit();
      } else {
        // Fallback for plain arrays
        const newArray = [...currentArray];
        newArray[index] = newItem;
        this.setValue(newArray);
      }
    }
  }
}

/**
 * Factory function for creating properly typed CellControllers
 */
export function createCellController<T>(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<T>,
): CellController<T> {
  return new CellController<T>(host, options);
}

/**
 * Factory function for string CellControllers (common case)
 */
export function createStringCellController(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<string>,
): StringCellController {
  return new StringCellController(host, options);
}

/**
 * Factory function for boolean CellControllers (common case)
 */
export function createBooleanCellController(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<boolean>,
): BooleanCellController {
  return new BooleanCellController(host, options);
}

/**
 * Factory function for array CellControllers (common case)
 */
export function createArrayCellController<T>(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<T[]>,
): ArrayCellController<T> {
  return new ArrayCellController<T>(host, options);
}
