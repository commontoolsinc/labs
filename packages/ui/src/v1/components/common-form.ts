import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.ts";
import { ZodObject } from "zod";
import { fromString } from "merkle-reference";

// Reference Field Component
export class ReferenceFieldElement extends LitElement {
  static override properties = {
    key: { type: String },
    value: { type: String },
    error: { type: String },
  };

  declare key: string;
  declare value: string;
  declare error: string;

  constructor() {
    super();
    this.key = "";
    this.value = "";
    this.error = "";
  }

  static override styles = css`
    :host {
      display: block;
    }
    .field-input {
      width: 100%;
      padding: var(--input-padding);
      border: 1px solid var(--form-border);
      border-radius: var(--form-radius);
      font-family: inherit;
    }
    .field-input.has-error {
      border-color: var(--error-color);
    }
    .field-error {
      color: var(--error-color);
      font-size: 0.875rem;
      margin-top: calc(var(--form-gap) * 0.25);
    }
  `;

  dispatch(value: string, error: string | null = null) {
    this.dispatchEvent(
      new CustomEvent("reference-changed", {
        detail: { value, error },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async validateReference(input: string) {
    try {
      const ref = await fromString(input);
      if (!ref) {
        return "Invalid reference format";
      }
      return null;
    } catch {
      return "Invalid reference format";
    }
  }

  override render() {
    return html`
      <input
        class="field-input ${this.error ? "has-error" : ""}"
        .value="${this.value}"
        @input="${(e: Event) => {
        const value = (e.target as HTMLInputElement).value;
        this.dispatch(value);
      }}"
        @blur="${async (e: Event) => {
        const error = await this.validateReference(
          (e.target as HTMLInputElement).value,
        );
        this.dispatch(this.value, error);
      }}"
      />
      ${this.error
        ? html`
          <div class="field-error">${this.error}</div>
        `
        : null}
    `;
  }
}
globalThis.customElements.define("reference-field", ReferenceFieldElement);

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

export class CommonFormElement extends LitElement {
  static override properties = {
    value: {},
    schema: { type: Object },
    fieldPath: { type: String, attribute: "field-path" },
    errors: { type: Object },
    reset: { type: Boolean },
    referenceFields: { type: Object },
  };
  private _internalValue: { [key: string]: any } = {};

  declare schema: ZodObject<any> | null;
  declare fieldPath: string;
  declare errors: { [key: string]: any };
  declare reset: boolean;
  declare referenceFields: Set<string>;

  constructor() {
    super();
    this.schema = null;
    this.fieldPath = "";
    this.errors = {};
    this.reset = false;
    this.referenceFields = new Set();
  }

  get value() {
    return this._internalValue;
  }

  set value(newValue: { [key: string]: any }) {
    const oldValue = this._internalValue;
    if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      this._internalValue = { ...newValue };
      this.requestUpdate("value", oldValue);
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has("schema") && this.schema) {
      this._internalValue = {
        ...this.getDefaultValue(this.schema),
        ...this._internalValue,
      };
    }
  }

  static override styles = [
    baseStyles,
    css`
      :host {
        --form-bg: #f0f0f0;
        --form-border: #ccc;
        --form-radius: 8px;
        --form-padding: 20px;
        --form-gap: 15px;
        --form-font: monospace;
        --form-width: 600px;
        --label-color: #666;
        --label-size: 12px;
        --input-padding: 10px;
        --error-color: #dc2626;
        --primary-color: #2563eb;
      }

      :host {
        display: block;
        padding: var(--form-padding);
        background: var(--form-bg);
        border: 2px solid var(--form-border);
        border-radius: var(--form-radius);
        font-family: var(--form-font);
        max-width: var(--form-width);
        margin: 0 auto;
      }

      .field {
        margin-bottom: var(--form-gap);
      }

      .field-label {
        display: block;
        font-size: var(--label-size);
        color: var(--label-color);
        font-weight: bold;
        text-transform: uppercase;
        margin-bottom: calc(var(--form-gap) * 0.25);
        cursor: help;
      }

      .field-input {
        width: 100%;
        padding: var(--input-padding);
        border: 1px solid var(--form-border);
        border-radius: var(--form-radius);
        font-family: inherit;
      }

      textarea.field-input {
        min-height: 200px;
        resize: vertical;
      }

      .field-error {
        color: var(--error-color);
        font-size: 0.875rem;
        margin-top: calc(var(--form-gap) * 0.25);
      }

      .field-input.has-error {
        border-color: var(--error-color);
      }

      .actions {
        display: flex;
        gap: var(--form-gap);
        margin-top: var(--form-gap);
      }

      button {
        padding: calc(var(--input-padding) * 0.8) var(--input-padding);
        border-radius: var(--form-radius);
        border: 1px solid var(--form-border);
        background: white;
        cursor: pointer;
        font-family: inherit;
      }

      button[type="submit"] {
        background: var(--primary-color);
        color: white;
        border: none;
      }

      button.icon-button {
        padding: calc(var(--input-padding) * 0.25);
        font-size: calc(var(--label-size) * 0.75);
      }

      .radio-group {
        display: flex;
        gap: var(--form-gap);
      }

      .checkbox-label {
        display: flex;
        align-items: center;
        gap: calc(var(--form-gap) * 0.5);
      }

      .list-controls {
        display: flex;
        flex-direction: column;
        gap: var(--form-gap);
      }

      .list-item {
        display: flex;
        gap: var(--form-gap);
        align-items: flex-start;
      }

      .list-item common-form {
        flex: 1;
      }

      .hidden-input {
        display: none;
      }
    `,
  ];

  dispatch(name: string, detail: any) {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        composed: true,
        detail: {
          path: this.fieldPath,
          ...detail,
        },
      }),
    );
  }

  getDefaultValue(schema: any) {
    if (!schema) return null;

    switch (schema._def.typeName) {
      case "ZodString":
        return "";
      case "ZodNumber":
        return 0;
      case "ZodBoolean":
        return false;
      case "ZodObject":
        return Object.entries(schema.shape).reduce(
          (acc: any, [key, fieldSchema]: [string, any]) => {
            acc[key] = this.getDefaultValue(fieldSchema);
            return acc;
          },
          {},
        );
      case "ZodEnum":
        return schema._def.values[0];
      case "ZodArray":
        return [];
      default:
        return null;
    }
  }

  generateSampleData() {
    if (!this.schema) {
      return;
    }
    const sample: any = {};
    for (const [key, fieldSchema] of Object.entries(this.schema.shape)) {
      switch ((fieldSchema as any)._def.typeName) {
        case "ZodString":
          sample[key] = `Sample ${key}`;
          break;
        case "ZodNumber":
          sample[key] = Math.floor(Math.random() * 100);
          break;
        case "ZodBoolean":
          sample[key] = Math.random() > 0.5;
          break;
        case "ZodObject":
          sample[key] = {};
          break;
        case "ZodEnum": {
          const values = (fieldSchema as any)._def.values;
          sample[key] = values[Math.floor(Math.random() * values.length)];
          break;
        }
        case "ZodArray":
          sample[key] = [];
          break;
      }
    }
    this._internalValue = sample;
    this.requestUpdate();
    this.dispatch("value-changed", { value: sample });
  }

  async handleFileImport() {
    const input = this.shadowRoot?.querySelector(
      "#file-input",
    ) as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      this._internalValue = json;
      this.requestUpdate();
      this.dispatch("value-changed", { value: json });
    } catch (error) {
      console.error("Failed to import JSON file:", error);
    }

    input.value = "";
  }

  handleInput(key: string, event: Event) {
    if (!this.schema) {
      return;
    }
    const fieldSchema = this.schema.shape[key];
    const target = event.target as HTMLInputElement;
    let value: any = target.value;

    if (fieldSchema._def.typeName === "ZodNumber") {
      value = value === "" ? 0 : Number(value);
    } else if (fieldSchema._def.typeName === "ZodBoolean") {
      value = target.checked;
    }

    this._internalValue = {
      ...this._internalValue,
      [key]: value,
    };

    try {
      fieldSchema.parse(value);
      this.errors = {
        ...this.errors,
        [key]: null,
      };
    } catch (error: any) {
      this.errors = {
        ...this.errors,
        [key]: error.errors[0].message,
      };
    }

    this.dispatch("value-changed", { value: this._internalValue });
    this.requestUpdate();
  }

  handleArrayUpdate(key: string, index: number, e: CustomEvent) {
    const value = [...(this._internalValue[key] || [])];
    value[index] = e.detail.value;

    this._internalValue = {
      ...this._internalValue,
      [key]: value,
    };

    if (e.detail.error) {
      this.errors = {
        ...this.errors,
        [`${key}.${index}`]: e.detail.error,
      };
    } else {
      const { [`${key}.${index}`]: _, ...newErrors } = this.errors;
      this.errors = newErrors;
    }

    this.dispatch("value-changed", { value: this._internalValue });
    this.requestUpdate();
  }

  handleReferenceChange(key: string, index: number | null, e: CustomEvent) {
    const value = e.detail.value;
    const error = e.detail.error;

    if (index !== null) {
      // Handle array item
      const arrayValue = [...(this._internalValue[key] || [])];
      arrayValue[index] = value;
      this._internalValue = {
        ...this._internalValue,
        [key]: arrayValue,
      };
      if (error) {
        this.errors = {
          ...this.errors,
          [`${key}.${index}`]: error,
        };
      } else {
        const { [`${key}.${index}`]: _, ...newErrors } = this.errors;
        this.errors = newErrors;
      }
    } else {
      // Handle single reference
      this._internalValue = {
        ...this._internalValue,
        [key]: value,
      };
      if (error) {
        this.errors = {
          ...this.errors,
          [key]: error,
        };
      } else {
        const { [key]: _, ...newErrors } = this.errors;
        this.errors = newErrors;
      }
    }

    this.dispatch("value-changed", { value: this._internalValue });
    this.requestUpdate();
  }

  addArrayItem(key: string) {
    if (!this.schema) {
      return;
    }
    const fieldSchema = this.schema.shape[key];
    const value = [...(this._internalValue[key] || [])];
    value.push(this.getDefaultValue(fieldSchema._def.innerType));

    this._internalValue = {
      ...this._internalValue,
      [key]: value,
    };

    this.requestUpdate();
  }

  removeArrayItem(key: string, index: number) {
    const value = [...(this._internalValue[key] || [])];
    value.splice(index, 1);

    this._internalValue = {
      ...this._internalValue,
      [key]: value,
    };

    this.requestUpdate();
  }

  async handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.schema) {
      return;
    }

    // Create a copy of the current value to modify
    const submitValue = { ...this._internalValue };

    // If there are reference fields, convert them before submission
    if (this.referenceFields.size > 0) {
      try {
        // Process all reference fields
        for (const key of this.referenceFields) {
          if (Array.isArray(submitValue[key])) {
            // Handle array of references
            submitValue[key] = await Promise.all(
              submitValue[key].map(async (str: string) => {
                const ref = await fromString(str);
                return ref;
              }),
            );
          } else {
            // Handle single reference
            submitValue[key] = await fromString(submitValue[key]);
          }
        }

        this.dispatch("submit", { value: submitValue });

        if (this.reset) {
          this._internalValue = this.getDefaultValue(this.schema);
          this.requestUpdate();
        }
        return;
      } catch (error) {
        console.error("Reference conversion failed:", error);
        return;
      }
    }

    // Handle non-reference fields validation as before
    try {
      const validated = await this.schema.parseAsync(submitValue);
      this.errors = {};
      this.dispatch("submit", { value: validated });

      if (this.reset) {
        this._internalValue = this.getDefaultValue(this.schema);
        this.requestUpdate();
      }
    } catch (error: any) {
      console.error("Validation failed:", error);
      this.errors = error.errors.reduce((acc: any, err: any) => {
        acc[err.path[0]] = err.message;
        return acc;
      }, {});
      this.requestUpdate();
    }
  }

  renderField(key: string, schema: any) {
    if (this.referenceFields.has(key)) {
      if (schema._def.typeName === "ZodArray") {
        const refs = this._internalValue[key] || [];

        return html`
          <div class="field">
            <label class="field-label" title="References to ${key}">
              ${key} (refs)
            </label>
            <div class="list-controls">
              ${refs.map(
            (ref: string, index: number) =>
              html`
                <div class="list-item">
                  <reference-field
                    .key="${key}"
                    .value="${ref}"
                    .error="${this.errors[`${key}.${index}`]}"
                    @reference-changed="${(e: CustomEvent) =>
                  this.handleReferenceChange(key, index, e)}"
                  ></reference-field>
                  <button
                    type="button"
                    class="icon-button"
                    @click="${() => this.removeArrayItem(key, index)}"
                  >
                    ❌
                  </button>
                </div>
              `,
          )}
              <button type="button" class="icon-button" @click="${() =>
            this.addArrayItem(key)}">
                ➕
              </button>
            </div>
          </div>
        `;
      } else {
        const ref = this._internalValue[key] || "";

        return html`
          <div class="field">
            <label class="field-label" title="Reference to ${key}">
              ${key} (ref)
            </label>
            <reference-field
              .key="${key}"
              .value="${ref}"
              .error="${this.errors[key]}"
              @reference-changed="${(e: CustomEvent) =>
            this.handleReferenceChange(key, null, e)}"
            ></reference-field>
          </div>
        `;
      }
    }

    const value = this._internalValue[key] ?? this.getDefaultValue(schema);
    const error = this.errors[key];
    const description = schema.description;

    const isLongString = schema._def.typeName === "ZodString" &&
      schema._def.checks?.some((check: any) =>
        check.kind === "max" && check.value > 1024
      );

    let input;

    if (schema._def.typeName === "ZodArray") {
      const items = value || [];
      const innerType = schema._def.type;
      const isPrimitive = ["ZodString", "ZodNumber", "ZodBoolean"].includes(
        innerType._def.typeName,
      );

      input = html`
        <div class="list-controls">
          ${items.map(
          (item: any, index: number) =>
            html`
              <div class="list-item">
                ${isPrimitive
                ? html`
                  <input
                    class="field-input"
                    .value="${item}"
                    type="${innerType._def.typeName === "ZodNumber"
                    ? "number"
                    : "text"}"
                    @input="${(e: Event) =>
                    this.handleArrayUpdate(
                      key,
                      index,
                      new CustomEvent("value-changed", {
                        detail: { value: (e.target as HTMLInputElement).value },
                      }),
                    )}"
                  />
                `
                : html`
                  <common-form
                    .schema="${innerType}"
                    .value="${item}"
                    field-path="${this.fieldPath
                    ? `${this.fieldPath}.${key}.${index}`
                    : `${key}.${index}`}"
                    @value-changed="${(e: CustomEvent) =>
                    this.handleArrayUpdate(key, index, e)}"
                  ></common-form>
                `}
                <button
                  type="button"
                  class="icon-button"
                  @click="${() => this.removeArrayItem(key, index)}"
                >
                  ❌
                </button>
              </div>
            `,
        )}
          <button type="button" class="icon-button" @click="${() =>
          this.addArrayItem(key)}">
            ➕
          </button>
        </div>
      `;
    } else if (schema._def.typeName === "ZodObject") {
      input = html`
        <common-form
          .schema="${schema}"
          .value="${value}"
          field-path="${this.fieldPath ? `${this.fieldPath}.${key}` : key}"
          @value-changed="${(e: CustomEvent) => this.handleInput(key, e)}"
        ></common-form>
      `;
    } else if (schema._def.typeName === "ZodBoolean") {
      input = html`
        <label class="checkbox-label">
          <input
            type="checkbox"
            .checked="${value}"
            @change="${(e: Event) => this.handleInput(key, e)}"
          />
          ${key.replace(/([A-Z])/g, " $1").trim()}
        </label>
      `;
    } else if (schema._def.typeName === "ZodEnum") {
      const values = schema._def.values;
      if (values.length <= 3) {
        input = html`
          <div class="radio-group">
            ${values.map(
            (v: string) =>
              html`
                <label>
                  <input
                    type="radio"
                    name="${key}"
                    value="${v}"
                    .checked="${value === v}"
                    @change="${(e: Event) => this.handleInput(key, e)}"
                  />
                  ${v}
                </label>
              `,
          )}
          </div>
        `;
      } else {
        input = html`
          <select
            class="field-input ${error ? "has-error" : ""}"
            @change="${(e: Event) => this.handleInput(key, e)}"
          >
            ${values.map(
            (v: string) =>
              html`
                <option value="${v}" ?selected="${value === v}">${v}</option>
              `,
          )}
          </select>
        `;
      }
    } else if (isLongString) {
      input = html`
        <textarea
          class="field-input ${error ? "has-error" : ""}"
          .value="${value}"
          @input="${(e: Event) => this.handleInput(key, e)}"
        ></textarea>
      `;
    } else {
      input = html`
        <input
          class="field-input ${error ? "has-error" : ""}"
          .value="${value}"
          type="${schema._def.typeName === "ZodNumber" ? "number" : "text"}"
          @input="${(e: Event) => this.handleInput(key, e)}"
        />
      `;
    }

    return html`
      <div class="field">
        <label class="field-label" title="${description || ""}">
          ${key.replace(/([A-Z])/g, " $1").trim()}
        </label>
        ${input} ${error
        ? html`
          <div class="field-error">${error}</div>
        `
        : null}
      </div>
    `;
  }

  override render() {
    if (!this.schema) {
      return html`
        <div>No schema provided</div>
      `;
    }

    return html`
      <form @submit="${this.handleSubmit}">
        ${Object.entries(this.schema.shape).map(([key, fieldSchema]) =>
        this.renderField(key, fieldSchema)
      )} ${this.fieldPath === ""
        ? html`
          <div class="actions">
            <button type="submit">Submit</button>
            <button type="button" class="icon-button" @click="${() =>
            this.generateSampleData()}">
              🎲
            </button>
            <input
              type="file"
              id="file-input"
              accept=".json"
              class="hidden-input"
              @change="${this.handleFileImport}"
            />
            <button
              type="button"
              class="icon-button"
              @click="${() =>
            (this.shadowRoot?.querySelector("#file-input") as HTMLInputElement)
              ?.click()}"
            >
              📄
            </button>
          </div>
        `
        : null}
      </form>
    `;
  }
}
globalThis.customElements.define("common-form", CommonFormElement);
