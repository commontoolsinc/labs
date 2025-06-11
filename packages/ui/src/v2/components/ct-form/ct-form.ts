import { css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTForm Component
 *
 * A form wrapper component that provides consistent layout and spacing for forms.
 * Emits a custom ct-submit event when the form is submitted.
 *
 * @element ct-form
 *
 * @attr {string} method - HTTP method for form submission (GET or POST)
 * @attr {string} action - URL for form submission
 *
 * @event ct-submit - Fired when the form is submitted (includes form data in detail)
 *
 * @slot - Form content (inputs, labels, buttons, etc.)
 *
 * @example
 * ```html
 * <ct-form method="POST" action="/api/submit">
 *   <ct-label for="name">Name</ct-label>
 *   <ct-input id="name" name="name" required></ct-input>
 *
 *   <ct-label for="email">Email</ct-label>
 *   <ct-input id="email" name="email" type="email" required></ct-input>
 *
 *   <div class="form-actions">
 *     <ct-button type="submit">Submit</ct-button>
 *     <ct-button type="button" variant="outline">Cancel</ct-button>
 *   </div>
 * </ct-form>
 * ```
 */
@customElement("ct-form")
export class CTForm extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --border: #e2e8f0;
      --ring: #94a3b8;

      /* Form spacing variables */
      --form-gap: 1.5rem;
      --form-field-gap: 0.5rem;
      --form-padding: 0;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: var(--form-gap);
      padding: var(--form-padding);
      width: 100%;
    }

    /* Direct children spacing */
    ::slotted(*) {
      margin: 0;
    }

    /* Common form field patterns */
    ::slotted(ct-label) {
      margin-bottom: var(--form-field-gap);
    }

    /* Field groups (divs, fieldsets) */
    ::slotted(div),
    ::slotted(fieldset) {
      display: flex;
      flex-direction: column;
      gap: var(--form-field-gap);
      margin: 0;
      padding: 0;
      border: none;
    }

    /* Horizontal field groups */
    ::slotted(.form-row),
    ::slotted([data-orientation="horizontal"]) {
      flex-direction: row;
      align-items: center;
      gap: 1rem;
    }

    /* Form sections */
    ::slotted(.form-section) {
      display: flex;
      flex-direction: column;
      gap: var(--form-gap);
    }

    /* Button groups typically at form bottom */
    ::slotted(.form-actions),
    ::slotted(.form-buttons) {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }

    /* Responsive adjustments */
    @media (max-width: 640px) {
      ::slotted(.form-row),
      ::slotted([data-orientation="horizontal"]) {
        flex-direction: column;
        align-items: stretch;
      }

      ::slotted(.form-actions),
      ::slotted(.form-buttons) {
        flex-direction: column;
      }

      ::slotted(.form-actions) ct-button,
      ::slotted(.form-buttons) ct-button {
        width: 100%;
      }
    }
  `;

  @property({ type: String })
  accessor method: "GET" | "POST" = "GET";

  @property({ type: String })
  accessor action = "";

  @query("form")
  private accessor _form!: HTMLFormElement;

  override render() {
    return html`
      <form method="${this.method}" action="${this.action}" @submit="${this
        .handleSubmit}">
        <slot></slot>
      </form>
    `;
  }

  private handleSubmit(event: Event): void {
    // Prevent default form submission
    event.preventDefault();
    event.stopPropagation();

    if (!this._form) return;

    // Collect form data
    const formData = new FormData(this._form);
    const data: Record<string, any> = {};

    // Convert FormData to plain object
    for (const [key, value] of formData.entries()) {
      if (data[key] !== undefined) {
        // Handle multiple values with same name (like checkboxes)
        if (!Array.isArray(data[key])) {
          data[key] = [data[key]];
        }
        data[key].push(value);
      } else {
        data[key] = value;
      }
    }

    // Emit custom event with form data
    const submitted = this.emit("ct-submit", {
      data,
      formData,
      method: this.method,
      action: this.action,
      form: this._form,
    });

    // If event wasn't prevented, submit the form natively
    if (submitted && this.action) {
      this._form.submit();
    }
  }

  /**
   * Get the form element
   */
  get form(): HTMLFormElement | null {
    return this._form;
  }

  /**
   * Submit the form programmatically
   */
  submit(): void {
    if (this._form) {
      const event = new Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      this._form.dispatchEvent(event);
    }
  }

  /**
   * Reset the form
   */
  reset(): void {
    if (this._form) {
      this._form.reset();
    }
  }

  /**
   * Check form validity
   */
  checkValidity(): boolean {
    return this._form?.checkValidity() ?? false;
  }

  /**
   * Report form validity
   */
  reportValidity(): boolean {
    return this._form?.reportValidity() ?? false;
  }
}
