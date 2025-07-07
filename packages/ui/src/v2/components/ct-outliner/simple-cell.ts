/**
 * Simple Cell implementation for ct-outliner migration
 * 
 * This is a minimal reactive cell implementation to support the migration
 * from direct Tree access to Cell<Tree> access pattern.
 */

export interface Cell<T> {
  get(): T;
  set(value: T): void;
}

/**
 * Create a simple reactive cell
 */
export function createSimpleCell<T>(initialValue: T): Cell<T> {
  let value = initialValue;
  
  return {
    get(): T {
      return value;
    },
    
    set(newValue: T): void {
      value = newValue;
    }
  };
}