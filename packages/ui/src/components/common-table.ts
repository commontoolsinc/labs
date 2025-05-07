import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { ZodObject } from "zod";

export class CommonCardElement extends LitElement {
  static override properties = {
    schema: { type: Object },
    item: { type: Object },
  };

  declare schema: ZodObject<any> | null;
  declare item: any;

  constructor() {
    super();
    this.schema = null;
    this.item = null;
  }

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        padding: 20px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      .field {
        margin-bottom: 16px;
      }
      .label {
        font-weight: 600;
        margin-bottom: 4px;
      }
      .value {
        color: #666;
        max-height: 128px;
        overflow-y: auto;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
      }
      .string-value {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .self-pill {
        display: inline-block;
        background: #f3f4f6;
        border-radius: 12px;
        padding: 2px 8px;
        font-family: monospace;
        font-size: 10px;
      }
    `,
  ];

  override render() {
    if (!this.item) {
      return html`<div>Missing data</div>`;
    }

    if (this.schema) {
      const entries = Object.entries(this.schema.shape);
      const nonSelfEntries = entries.filter(([key]) => key !== "self");
      const selfEntry = entries.find(([key]) => key === "self");

      return html`
        ${
        nonSelfEntries.map(
          ([key, schema]) =>
            html`
            <div class="field">
              <div class="label">${key.replace(/([A-Z])/g, " $1").trim()}</div>
              <div class="value">${
              this.formatValue(this.item[key], schema, key)
            }</div>
            </div>
          `,
        )
      }
        ${
        selfEntry
          ? html`
              <div class="field">
                <div class="label">${
            selfEntry[0].replace(/([A-Z])/g, " $1").trim()
          }</div>
                <div class="value">
                  ${
            this.formatValue(
              this.item[selfEntry[0]],
              selfEntry[1],
              selfEntry[0],
            )
          }
                </div>
              </div>
            `
          : ""
      }
      `;
    }

    const entries = Object.entries(this.item);
    const nonSelfEntries = entries.filter(([key]) => key !== "self");
    const selfEntry = entries.find(([key]) => key === "self");

    return html`
      ${
      nonSelfEntries.map(
        ([key, value]) =>
          html`
          <div class="field">
            <div class="label">${key.replace(/([A-Z])/g, " $1").trim()}</div>
            <div class="value">${this.formatValue(value, undefined, key)}</div>
          </div>
        `,
      )
    }
      ${
      selfEntry
        ? html`
            <div class="field">
              <div class="label">${
          selfEntry[0].replace(/([A-Z])/g, " $1").trim()
        }</div>
              <div class="value">${
          this.formatValue(selfEntry[1], undefined, selfEntry[0])
        }</div>
            </div>
          `
        : ""
    }
    `;
  }

  formatValue(value: any, schema?: any, key?: string) {
    if (value === null || value === undefined) {
      return "";
    }

    if (key === "self") {
      return html`<span class="self-pill">${value.toString()}</span>`;
    }

    if (schema) {
      switch (schema._def.typeName) {
        case "ZodArray":
        case "ZodObject":
          return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
        case "ZodBoolean":
          return value ? "✓" : "✗";
        case "ZodDate":
          return new Date(value).toLocaleString();
        case "ZodString":
          return html`<div class="string-value">${value}</div>`;
        default:
          return String(value);
      }
    }

    if (typeof value === "object") {
      return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
    } else if (typeof value === "boolean") {
      return value ? "✓" : "✗";
    } else if (value instanceof Date) {
      return value.toLocaleString();
    }
    return html`<div class="string-value">${value}</div>`;
  }
}
globalThis.customElements.define("common-card", CommonCardElement);

export class CommonTableElement extends LitElement {
  static override properties = {
    schema: { type: Object },
    data: { type: Array },
    edit: { type: Boolean },
    delete: { type: Boolean },
    preview: { type: Boolean },
    download: { type: Boolean },
    copy: { type: Boolean },
    selectedItem: { state: true },
  };

  declare schema: ZodObject<any> | null;
  declare data: any[];
  declare edit: boolean;
  declare delete: boolean;
  declare preview: boolean;
  declare download: boolean;
  declare copy: boolean;
  declare selectedItem: any;

  constructor() {
    super();
    this.schema = null;
    this.data = [];
    this.edit = false;
    this.delete = false;
    this.preview = false;
    this.download = false;
    this.copy = false;
    this.selectedItem = null;
  }

  static override styles = [
    baseStyles,
    css`
      :host {
        --table-bg: #fff;
        --table-border: #e5e7eb;
        --table-header-bg: #f9fafb;
        --table-stripe-bg: #f3f4f6;
        --table-font: system-ui, sans-serif;
        --cell-padding: 12px;
        --max-cell-width: 200px;
      }

      .table-container {
        overflow-x: auto;
        border: 1px solid var(--table-border);
        border-radius: 8px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-family: var(--table-font);
        font-size: 14px;
      }

      th {
        background: var(--table-header-bg);
        font-weight: 600;
        text-align: left;
        padding: var(--cell-padding);
        border-bottom: 2px solid var(--table-border);
        position: sticky;
        top: 0;
        cursor: help;
      }

      td {
        padding: var(--cell-padding);
        border-bottom: 1px solid var(--table-border);
        max-width: var(--max-cell-width);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      tr:nth-child(even) {
        background: var(--table-stripe-bg);
      }

      .complex-value {
        font-family: monospace;
        font-size: 12px;
        color: #666;
      }

      .preview-button,
      .edit-button,
      .delete-button,
      .download-button,
      .copy-button,
      .download-all-button,
      .import-button {
        padding: 4px 8px;
        background: #f3f4f6;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        cursor: pointer;
        margin-right: 4px;
      }

      .delete-button {
        background: #fee2e2;
        border-color: #fecaca;
      }

      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .modal-content {
        background: white;
        padding: 20px;
        border-radius: 8px;
        max-width: 600px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }

      .close-button {
        float: right;
        padding: 8px;
        cursor: pointer;
      }
    `,
  ];

  formatValue(value: any, schema: any) {
    if (value === null || value === undefined) {
      return "";
    }

    switch (schema._def.typeName) {
      case "ZodArray":
      case "ZodObject":
        return html`
          <span class="complex-value" title=${JSON.stringify(value)}>
            ${JSON.stringify(value).slice(0, 50)}${
          JSON.stringify(value).length > 50 ? "..." : ""
        }
          </span>
        `;
      case "ZodBoolean":
        return value ? "✓" : "✗";
      case "ZodDate":
        return new Date(value).toLocaleString();
      default:
        return String(value);
    }
  }

  showPreview(item: any) {
    this.selectedItem = item;
  }

  closePreview() {
    this.selectedItem = null;
  }

  handleEdit(item: any) {
    this.dispatchEvent(
      new CustomEvent("edit", {
        detail: { item: item.self },
        bubbles: true,
        composed: true,
      }),
    );
  }

  handleDelete(item: any) {
    if (confirm("Are you sure you want to delete this item?")) {
      this.dispatchEvent(
        new CustomEvent("delete", {
          detail: { item: item.self },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  handleDownload(item: any) {
    const data = JSON.stringify(item, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    globalThis.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  handleDownloadAll() {
    const data = JSON.stringify(this.data, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `all-data-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    globalThis.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  async handleCopySelf(item: any) {
    try {
      await navigator.clipboard.writeText(item.self.toString());
    } catch (err) {
      console.error("Failed to copy self property:", err);
    }
  }

  handleImport(_: Event) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!this.schema) return;

      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const items = Array.isArray(json) ? json : [json];

        // Validate each item against schema
        const validItems = [];
        for (const item of items) {
          try {
            const validItem = this.schema.parse(item);
            validItems.push(validItem);
          } catch (err) {
            console.error("Validation failed for item:", item, err);
          }
        }

        if (validItems.length > 0) {
          this.dispatchEvent(
            new CustomEvent("import", {
              detail: { items: validItems },
              bubbles: true,
              composed: true,
            }),
          );
        }
      } catch (err) {
        console.error("Failed to parse JSON:", err);
      }
    };

    input.click();
  }

  override render() {
    if (!this.schema) {
      return html`<div>No schema provided</div>`;
    }

    if (!this.data || !this.data.length) {
      return html`<div>No data available</div>`;
    }

    const shape = this.schema ? this.schema.shape : {};

    return html`
      <button class="download-all-button" @click=${this.handleDownloadAll}>
        Download All Records
      </button>
      <button class="import-button" @click=${this.handleImport}>Import JSON</button>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              ${
      Object.entries(this.schema.shape).map(
        ([key]) => html` <th>${key.replace(/([A-Z])/g, " $1").trim()}</th> `,
      )
    }
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
      this.data.map(
        (row) =>
          html`
                <tr>
                  ${
            Object.entries(shape).map(
              ([key, schema]) =>
                html`
                      <td title=${String(row[key])}>${
                  this.formatValue(row[key], schema)
                }</td>
                    `,
            )
          }
                  <td>
                    ${
            this.preview
              ? html`
                          <button class="preview-button" @click=${() =>
                this.showPreview(row)}>
                            Preview
                          </button>
                        `
              : ""
          }
                    ${
            this.edit
              ? html`
                          <button class="edit-button" @click=${() =>
                this.handleEdit(row)}>
                            Edit
                          </button>
                        `
              : ""
          }
                    ${
            this.delete
              ? html`
                          <button class="delete-button" @click=${() =>
                this.handleDelete(row)}>
                            Delete
                          </button>
                        `
              : ""
          }
                    ${
            this.download
              ? html`
                          <button class="download-button" @click=${() =>
                this.handleDownload(row)}>
                            Download
                          </button>
                        `
              : ""
          }
                    ${
            this.copy
              ? html`
                          <button class="copy-button" @click=${() =>
                this.handleCopySelf(row)}>
                            Copy Ref
                          </button>
                        `
              : ""
          }
                  </td>
                </tr>
              `,
      )
    }
          </tbody>
        </table>
      </div>

      ${
      this.selectedItem
        ? html`
            <div class="modal-overlay" @click=${this.closePreview}>
              <div class="modal-content" @click=${(e: Event) =>
          e.stopPropagation()}>
                <button class="close-button" @click=${this.closePreview}>×</button>
                <common-card .schema=${this.schema} .item=${this.selectedItem}></common-card>
              </div>
            </div>
          `
        : ""
    }
    `;
  }
}
globalThis.customElements.define("common-table", CommonTableElement);
