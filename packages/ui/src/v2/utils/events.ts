/**
 * Event helper utilities for web components
 */

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function (this: any, ...args: Parameters<T>) {
    if (timeout !== null) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func.apply(this, args);
      timeout = null;
    }, wait);
  };
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number,
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return function (this: any, ...args: Parameters<T>) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;

      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Create a custom event with proper typing
 */
export function createEvent<T = any>(
  type: string,
  detail?: T,
  options?: EventInit,
): CustomEvent<T> {
  return new CustomEvent<T>(type, {
    detail,
    bubbles: true,
    composed: true,
    ...options,
  });
}

/**
 * Event listener with cleanup
 */
export class EventManager {
  private listeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListener;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  /**
   * Add an event listener
   */
  add(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  /**
   * Remove all event listeners
   */
  removeAll(): void {
    this.listeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.listeners = [];
  }

  /**
   * Remove specific event listener
   */
  remove(target: EventTarget, type: string, listener: EventListener): void {
    const index = this.listeners.findIndex(
      (l) => l.target === target && l.type === type && l.listener === listener,
    );

    if (index !== -1) {
      const { options } = this.listeners[index];
      target.removeEventListener(type, listener, options);
      this.listeners.splice(index, 1);
    }
  }
}
