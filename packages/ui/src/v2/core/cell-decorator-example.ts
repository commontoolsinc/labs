/**
 * Example usage of the @cell() decorator
 * This file demonstrates how to use the @cell decorator with Lit components
 */

import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { type Cell } from "@commontools/runner";
import { BaseElement } from "./base-element.ts";
import { cell, setCellValue } from "./cell-decorator.ts";

@customElement("example-cell-input")
export class ExampleCellInput extends BaseElement {
  /**
   * Cell<T> property with debounced updates
   * The @cell decorator handles subscription management automatically
   */
  @cell({ 
    timing: { strategy: "debounce", delay: 300 }
  })
  value: Cell<string> | undefined;

  /**
   * Cell<T> property with immediate updates
   */
  @cell({ 
    timing: { strategy: "immediate" }
  })
  counter: Cell<number> | undefined;

  /**
   * Cell<T> property with blur-only updates (good for forms)
   */
  @cell({ 
    timing: { strategy: "blur" }
  })
  email: Cell<string> | undefined;

  static override styles = css`
    :host {
      display: block;
      padding: 1rem;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    
    .field {
      margin-bottom: 1rem;
    }
    
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: bold;
    }
    
    input {
      width: 100%;
      padding: 0.5rem;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    
    button {
      padding: 0.5rem 1rem;
      background: #007cba;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .current-values {
      margin-top: 1rem;
      padding: 1rem;
      background: #f5f5f5;
      border-radius: 4px;
    }
  `;

  override render() {
    return html`
      <div class="field">
        <label for="value-input">Value (debounced, 300ms):</label>
        <input 
          id="value-input"
          type="text" 
          .value="${this.value?.get?.() || ''}"
          @input="${this.handleValueInput}"
        />
      </div>

      <div class="field">
        <label for="counter-display">Counter (immediate updates):</label>
        <div>${this.counter?.get?.() || 0}</div>
        <button @click="${this.incrementCounter}">Increment</button>
        <button @click="${this.decrementCounter}">Decrement</button>
      </div>

      <div class="field">
        <label for="email-input">Email (blur-only updates):</label>
        <input 
          id="email-input"
          type="email" 
          .value="${this.email?.get?.() || ''}"
          @input="${this.handleEmailInput}"
          @blur="${this.handleEmailBlur}"
        />
      </div>

      <div class="current-values">
        <h3>Current Cell Values:</h3>
        <p><strong>Value:</strong> ${this.value?.get?.() || 'undefined'}</p>
        <p><strong>Counter:</strong> ${this.counter?.get?.() || 'undefined'}</p>
        <p><strong>Email:</strong> ${this.email?.get?.() || 'undefined'}</p>
      </div>
    `;
  }

  private handleValueInput(event: Event) {
    const input = event.target as HTMLInputElement;
    // The @cell decorator with debounce timing will handle the delay
    setCellValue(this, 'value', input.value);
  }

  private handleEmailInput(event: Event) {
    const input = event.target as HTMLInputElement;
    // Store the value temporarily, will be committed on blur
    this.tempEmailValue = input.value;
  }
  
  private tempEmailValue: string = '';

  private handleEmailBlur() {
    // The @cell decorator with blur timing will handle this
    setCellValue(this, 'email', this.tempEmailValue);
  }

  private incrementCounter() {
    if (this.counter) {
      const currentValue = this.counter.get?.() || 0;
      // Immediate timing - no delay
      setCellValue(this, 'counter', currentValue + 1);
    }
  }

  private decrementCounter() {
    if (this.counter) {
      const currentValue = this.counter.get?.() || 0;
      // Immediate timing - no delay  
      setCellValue(this, 'counter', currentValue - 1);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "example-cell-input": ExampleCellInput;
  }
}

/**
 * Usage Notes:
 * 
 * 1. The @cell() decorator automatically manages Cell subscriptions
 *    - Subscribes when a Cell is assigned to the property
 *    - Unsubscribes when the property changes or element disconnects
 *    - Triggers component re-renders when Cell values change
 * 
 * 2. Use setCellValue() instead of directly calling cell.set()
 *    - Respects the timing strategy configured in the decorator
 *    - Handles transactions automatically
 *    - Provides consistent behavior across components
 * 
 * 3. Timing strategies:
 *    - "immediate": Updates happen right away
 *    - "debounce": Delays updates, good for text inputs
 *    - "throttle": Limits update frequency
 *    - "blur": Only updates when input loses focus
 * 
 * 4. The decorator only works with Cell<T> properties
 *    - Does not support Cell<T> | T unions
 *    - Simplifies implementation and usage
 *    - Use regular @property() for non-Cell properties
 */