/**
 * Simple Cell implementation for UI components
 * 
 * This provides a basic Cell<T> implementation that works with UI components
 * that need reactive state management. It implements the Cell<T> interface
 * but with simplified reactivity - perfect for UI testing and development.
 */

import type { Cell as RunnerCell } from "@commontools/runner";

// Export a simplified Cell interface for UI components
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  update(partial: Partial<T>): void;
  push(...items: any[]): void;
  key<K extends keyof T>(key: K): Cell<T[K]>;
  sink(callback: (value: T) => void): () => void;
  equals(other: Cell<T>): boolean;
  readonly value: T;
  asSchema(): Cell<T>;
  withLog(): Cell<T>;
}

/**
 * Simple implementation of Cell<T> for UI components
 * 
 * This is a lightweight implementation that provides the basic Cell<T> interface
 * needed by UI components. It includes reactive change detection through direct
 * object mutation monitoring.
 */
export class SimpleCell<T> implements Cell<T> {
  private _value: T;
  private _changeCallbacks: Set<(value: T) => void> = new Set();

  constructor(initialValue: T) {
    this._value = initialValue;
  }

  get(): T {
    return this._value;
  }

  set(value: T): void {
    if (this._value !== value) {
      this._value = value;
      this._notifyChanges();
    }
  }

  // Alias for set() to match Cell<T> interface
  send(value: T): void {
    this.set(value);
  }

  // Simplified update for object properties
  update(partial: Partial<T>): void {
    if (typeof this._value === 'object' && this._value !== null) {
      Object.assign(this._value, partial);
      this._notifyChanges();
    }
  }

  // Simplified push for arrays
  push(...items: any[]): void {
    if (Array.isArray(this._value)) {
      (this._value as any).push(...items);
      this._notifyChanges();
    }
  }

  // Basic key access - returns a new SimpleCell for the nested value
  key<K extends keyof T>(key: K): Cell<T[K]> {
    const nestedValue = this._value[key];
    const nestedCell = new SimpleCell(nestedValue);
    
    // Update nested value when parent changes
    this.sink((newValue) => {
      nestedCell.set(newValue[key]);
    });
    
    // Update parent when nested value changes
    nestedCell.sink((newNestedValue) => {
      if (typeof this._value === 'object' && this._value !== null) {
        (this._value as any)[key] = newNestedValue;
        this._notifyChanges();
      }
    });
    
    return nestedCell;
  }

  // Subscribe to changes
  sink(callback: (value: T) => void): () => void {
    this._changeCallbacks.add(callback);
    return () => {
      this._changeCallbacks.delete(callback);
    };
  }

  // Basic equality check
  equals(other: Cell<T>): boolean {
    return this._value === other.get();
  }

  // Property getter (same as get())
  get value(): T {
    return this._value;
  }

  // Additional Cell<T> interface methods (simplified implementations)
  asSchema(): Cell<T> {
    return this;
  }

  withLog(): Cell<T> {
    return this;
  }

  private _notifyChanges(): void {
    for (const callback of this._changeCallbacks) {
      callback(this._value);
    }
  }
}

/**
 * Factory function to create SimpleCell instances
 * 
 * This provides a convenient way to create SimpleCell instances
 * that match the Cell<T> interface for UI components.
 */
export function createSimpleCell<T>(initialValue: T): Cell<T> {
  return new SimpleCell(initialValue);
}