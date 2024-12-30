import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";
import { ZodObject } from "zod";

export const commonTable = view("common-table", {
  ...eventProps(),
});

export const commonCard = view("common-card", {
  ...eventProps(),
});

@customElement("common-card")
export class CommonCardElement extends LitElement {
  @property({ type: Object }) schema: ZodObject<any> = null;
  @property({ type: Object }) item: any = null;

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        padding: 20px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
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
      }
    `
  ];

  override render() {
    if (!this.schema || !this.item) {
      return html`<div>Missing schema or data</div>`;
    }

    return html`
      ${Object.entries(this.schema.shape).map(([key, schema]) => html`
        <div class="field">
          <div class="label">${key.replace(/([A-Z])/g, ' $1').trim()}</div>
          <div class="value">${this.formatValue(this.item[key], schema)}</div>
        </div>
      `)}
    `;
  }

  formatValue(value: any, schema: any) {
    if (value === null || value === undefined) {
      return '';
    }

    switch (schema._def.typeName) {
      case 'ZodArray':
      case 'ZodObject':
        return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
      case 'ZodBoolean':
        return value ? '✓' : '✗';
      case 'ZodDate':
        return new Date(value).toLocaleString();
      default:
        return String(value);
    }
  }
}
@customElement("common-table")
export class CommonTableElement extends LitElement {
  @property({ type: Object }) schema: ZodObject<any> = null;
  @property({ type: Array }) data: any[] = [];
  @state() selectedItem: any = null;

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

      .preview-button, .edit-button, .delete-button, .download-button, .copy-button {
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
        background: rgba(0,0,0,0.5);
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
      return '';
    }

    switch (schema._def.typeName) {
      case 'ZodArray':
      case 'ZodObject':
        return html`
          <span class="complex-value" title=${JSON.stringify(value)}>
            ${JSON.stringify(value).slice(0, 50)}${JSON.stringify(value).length > 50 ? '...' : ''}
          </span>
        `;
      case 'ZodBoolean':
        return value ? '✓' : '✗';
      case 'ZodDate':
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
    this.dispatchEvent(new CustomEvent('edit', {
      detail: { item: item.self },
      bubbles: true,
      composed: true
    }));
  }

  handleDelete(item: any) {
    if (confirm('Are you sure you want to delete this item?')) {
      this.dispatchEvent(new CustomEvent('delete', {
        detail: { item: item.self },
        bubbles: true,
        composed: true
      }));
    }
  }

  handleDownload(item: any) {
    const data = JSON.stringify(item, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  async handleCopySelf(item: any) {
    try {
      await navigator.clipboard.writeText(item.self.toString());
    } catch (err) {
      console.error('Failed to copy self property:', err);
    }
  }

  override render() {
    if (!this.schema) {
      return html`<div>No schema provided</div>`;
    }

    if (!this.data || !this.data.length) {
      return html`<div>No data available</div>`;
    }

    return html`
      <div class="table-container">
        <table>
          <thead>
            <tr>
              ${Object.entries(this.schema.shape).map(([key,]) => html`
                <th>${key.replace(/([A-Z])/g, ' $1').trim()}</th>
              `)}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${this.data.map(row => html`
              <tr>
                ${Object.entries(this.schema.shape).map(([key, schema]) => html`
                  <td title=${String(row[key])}>
                    ${this.formatValue(row[key], schema)}
                  </td>
                `)}
                <td>
                  <button class="preview-button" @click=${() => this.showPreview(row)}>Preview</button>
                  <button class="edit-button" @click=${() => this.handleEdit(row)}>Edit</button>
                  <button class="delete-button" @click=${() => this.handleDelete(row)}>Delete</button>
                  <button class="download-button" @click=${() => this.handleDownload(row)}>Download</button>
                  <button class="copy-button" @click=${() => this.handleCopySelf(row)}>Copy Self</button>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>

      ${this.selectedItem ? html`
        <div class="modal-overlay" @click=${this.closePreview}>
          <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
            <button class="close-button" @click=${this.closePreview}>×</button>
            <common-card .schema=${this.schema} .item=${this.selectedItem}></common-card>
          </div>
        </div>
      ` : ''}
    `;
  }
}
