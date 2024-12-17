import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";
import { ZodObject } from "zod";

export const commonForm = view("common-form", {
  ...eventProps(),
});
export type ZodFormEvent = {
  path: string;
  value: any;
};

export class ZodFormSubmitEvent extends Event {
  detail: ZodFormEvent;

  constructor(detail: ZodFormEvent) {
    super("zod-submit", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

@customElement("common-form")
export class CommonFormElement extends LitElement {
  private _internalValue: { [key: string]: any } = {};
  @property({ type: Object }) schema: ZodObject<any> = null;
  @property({ type: String, attribute: 'field-path' }) fieldPath = '';
  @property({ type: Object }) errors: { [key: string]: any } = {};

  @property({ type: Object })
  get value() {
    return this._internalValue;
  }

  set value(newValue: { [key: string]: any }) {
    const oldValue = this._internalValue;
    if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      this._internalValue = { ...newValue };
      this.requestUpdate('value', oldValue);
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has('schema') && this.schema) {
      this._internalValue = {
        ...this.getDefaultValue(this.schema),
        ...this._internalValue
      };
    }
  }

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        padding: 1rem;
      }
      .field {
        margin-bottom: 1rem;
      }
      .field-label {
        display: block;
        font-weight: 500;
        margin-bottom: 0.25rem;
      }
      .field-input {
        width: 100%;
        padding: 0.5rem;
        border: 1px solid #ccc;
        border-radius: 4px;
      }
      textarea.field-input {
        min-height: 200px;
        resize: vertical;
      }
      .field-error {
        color: #dc2626;
        font-size: 0.875rem;
        margin-top: 0.25rem;
      }
      .field-input.has-error {
        border-color: #dc2626;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 1rem;
      }
      button {
        padding: 0.5rem 1rem;
        border-radius: 4px;
        border: 1px solid #ccc;
        background: white;
        cursor: pointer;
      }
      button[type="submit"] {
        background: #2563eb;
        color: white;
        border: none;
      }
    `,
  ];

  dispatch(name: string, detail: any) {
    this.dispatchEvent(new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail: {
        path: this.fieldPath,
        ...detail
      }
    }));
  }

  getDefaultValue(schema: any) {
    if (!schema) return null;

    switch (schema._def.typeName) {
      case 'ZodString':
        return '';
      case 'ZodNumber':
        return 0;
      case 'ZodBoolean':
        return false;
      case 'ZodObject':
        return Object.entries(schema.shape)
          .reduce((acc: any, [key, fieldSchema]: [string, any]) => {
            acc[key] = this.getDefaultValue(fieldSchema);
            return acc;
          }, {});
      default:
        return null;
    }
  }

  generateSampleData() {
    const sample: any = {};
    debugger
    for (const [key, fieldSchema] of Object.entries(this.schema.shape)) {
      switch ((fieldSchema as any)._def.innerType._def.typeName) {
        case 'ZodString':
          sample[key] = `Sample ${key}`;
          break;
        case 'ZodNumber':
          sample[key] = Math.floor(Math.random() * 100);
          break;
        case 'ZodBoolean':
          sample[key] = Math.random() > 0.5;
          break;
        case 'ZodObject':
          sample[key] = {};
          break;
      }
    }
    this._internalValue = sample;
    this.requestUpdate();
    this.dispatch('value-changed', { value: sample });
  }

  handleInput(key: string, event: Event) {
    const fieldSchema = this.schema.shape[key];
    const rawValue = (event.target as HTMLInputElement).value;

    let parsedValue: string | number = rawValue;
    if (fieldSchema._def.typeName === 'ZodNumber') {
      parsedValue = rawValue === '' ? 0 : Number(rawValue);
    }

    this._internalValue = {
      ...this._internalValue,
      [key]: parsedValue
    };

    try {
      fieldSchema.parse(parsedValue);
      this.errors = {
        ...this.errors,
        [key]: null
      };
    } catch (error: any) {
      this.errors = {
        ...this.errors,
        [key]: error.errors[0].message
      };
    }

    this.dispatch('value-changed', { value: this._internalValue });
    this.requestUpdate();
  }

  async handleSubmit(e: Event) {
    e.preventDefault();

    try {
      const validated = await this.schema.parseAsync(this._internalValue);
      this.errors = {};
      this.dispatch('submit', { value: validated });
      console.log('Form submitted:', validated);
    } catch (error: any) {
      this.errors = error.errors.reduce((acc: any, err: any) => {
        acc[err.path[0]] = err.message;
        return acc;
      }, {});
      this.requestUpdate();
    }
  }

  renderField(key: string, schema: any) {
    const value = this._internalValue[key] ?? this.getDefaultValue(schema);
    const error = this.errors[key];

    const isLongString = schema._def.typeName === 'ZodString' &&
      schema._def.checks?.some((check: any) =>
        check.kind === 'max' && check.value > 1024
      );

    const input = isLongString ? html`
      <textarea
        class="field-input ${error ? 'has-error' : ''}"
        .value=${value}
        @input=${(e: Event) => this.handleInput(key, e)}
      ></textarea>
    ` : html`
      <input
        class="field-input ${error ? 'has-error' : ''}"
        .value=${value}
        type=${schema._def.typeName === 'ZodNumber' ? 'number' : 'text'}
        @input=${(e: Event) => this.handleInput(key, e)}
      />
    `;

    return html`
      <div class="field">
        <label class="field-label">
          ${key.replace(/([A-Z])/g, ' $1').trim()}
        </label>
        ${input}
        ${error ? html`
          <div class="field-error">${error}</div>
        ` : null}
      </div>
    `;
  }

  override render() {
    if (!this.schema) {
      return html`<div>No schema provided</div>`;
    }

    return html`
      <form @submit=${this.handleSubmit}>
        ${Object.entries(this.schema.shape).map(([key, fieldSchema]) =>
          this.renderField(key, fieldSchema)
        )}

        <div class="actions">
          <button type="submit">Submit</button>
          <button
            type="button"
            @click=${() => this.generateSampleData()}
          >
            Generate Sample Data
          </button>
        </div>
      </form>
    `;
  }
}
