import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('common-import')
export class JsonFileDrop extends LitElement {
  @state() private jsonContent: object | null = null;

  static override styles = css`
    :host {
      display: block;
      padding: 20px;
      border: 2px dashed #ccc;
      border-radius: 10px;
      text-align: center;
      cursor: pointer;
    }
    :host(.dragover) {
      background-color: #f0f0f0;
      border-color: #999;
    }

    .content {
      text-align: left;
    }
  `;

  constructor() {
    super();
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
  }

  private onDragOver(e: DragEvent) {
    e.preventDefault();
    this.classList.add('dragover');
  }

  private onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.classList.remove('dragover');
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    this.classList.remove('dragover');

    const file = e.dataTransfer?.files[0];
    if (file && file.type === 'application/json') {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          this.jsonContent = JSON.parse(event.target?.result as string);
          this.dispatchEvent(new CustomEvent('common-data', { detail: this.jsonContent }));
        } catch (error) {
          console.error('Error parsing JSON:', error);
        }
      };
      reader.readAsText(file);
    }
  }

  override render() {
    return html`
      <div>
        ${this.jsonContent
          ? html`<pre class="content">${JSON.stringify(this.jsonContent, null, 2)}</pre>`
          : html`Drop your JSON file here`}
      </div>
    `;
  }
}
