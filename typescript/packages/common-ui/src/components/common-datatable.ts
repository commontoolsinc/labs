import { LitElement, html, css } from 'lit-element';
import { customElement, property } from 'lit-element/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

@customElement('common-datatable')
export class CommonDatatableElement extends LitElement {
  static override styles = css`
  :host {
    display: block;
    --cell-padding: 8px;
  }

  .viewport {
    overflow-x: auto;
  }

  .table {
    border-collapse: collapse;
    border: 1px solid #ddd;
    table-layout: fixed;
    min-width: 100%;
  }

  .cell {
    padding: var(--cell-padding);
    border: 1px solid #ddd;
    min-width: 12em;
    max-width: 24em;
    vertical-align: top;
  }
  `;

  @property({ type: Array })
  cols: Array<string>;

  @property({ type: Array })
  rows: Array<Record<string, string>>;

  override render() {
    const rows = repeat(this.rows, (row) => {
      const cells = repeat(
        this.cols,
        (col) => {
          return html`<td class="cell">${row[col]}</td>`
        }
      );
      return html`<tr class="row">${cells}</tr>`;
    })

    return html`
    <div class="viewport">
      <table class="table">${rows}</table>
    </div>
    `;
  }
}