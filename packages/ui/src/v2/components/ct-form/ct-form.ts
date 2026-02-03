import { css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { provide } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  type FieldRegistration,
  type FormContext,
  formContext,
} from "../form-context.ts";

/**
 * CTForm Component
 *
 * A form wrapper component that provides consistent layout and spacing for forms.
 * Emits a custom ct-submit event when the form is submitted.
 *
 * Provides FormContext to descendant fields for coordinated submission with:
 * - Field validation before submit
 * - Atomic flushing of buffered values on submit
 * - Coordinated reset of all fields
 *
 * @element ct-form
 *
 * @attr {string} method - HTTP method for form submission (GET or POST)
 * @attr {string} action - URL for form submission
 *
 * @event ct-submit - Fired when the form is submitted and all fields are valid (includes form data in detail)
 * @event ct-form-invalid - Fired when submit is attempted but validation fails (includes errors in detail)
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

  @property()
  method: "GET" | "POST" = "GET";

  @property()
  action = "";

  @query("form")
  private _form!: HTMLFormElement;

  /** Track registered fields for coordinated submit/reset */
  private _fields = new Map<HTMLElement, FieldRegistration>();

  /** Provide FormContext to descendant fields */
  @provide({ context: formContext })
  private _formContext: FormContext = {
    registerField: (reg) => this._registerField(reg),
  };

  /**
   * Register a field with the form
   * @param reg - Field registration with buffer and validation handlers
   * @returns Unregister function to call on disconnectedCallback
   */
  private _registerField(reg: FieldRegistration): () => void {
    this._fields.set(reg.element, reg);
    return () => {
      this._fields.delete(reg.element);
    };
  }

  override render() {
    return html`
      <form method="${this.method}" action="${this.action}" @submit="${this
        .handleSubmit}">
        <slot></slot>
      </form>
    `;
  }

  private handleSubmit(event: Event): void {
    console.log("ct-form handleSubmit called", event);
    // Prevent default form submission
    event.preventDefault();
    event.stopPropagation();

    if (!this._form) {
      console.log("ct-form: _form is null");
      return;
    }
    console.log("ct-form: _form is", this._form);
    console.log("ct-form: registered fields count:", this._fields.size);

    // Validate all registered fields
    const errors: Array<{ element: HTMLElement; message?: string }> = [];
    for (const [element, field] of this._fields) {
      const result = field.validate();
      if (!result.valid) {
        errors.push({ element, message: result.message });
      }
    }

    // If any fields are invalid, emit error event and return early
    if (errors.length > 0) {
      this.emit("ct-form-invalid", { errors });
      return;
    }

    // Flush all registered fields (write buffered values to cells)
    for (const field of this._fields.values()) {
      field.flush();
    }

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

    console.log("ct-form: about to emit ct-submit");
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
    // Reset all registered fields to their initial cell values
    for (const field of this._fields.values()) {
      field.reset();
    }

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
