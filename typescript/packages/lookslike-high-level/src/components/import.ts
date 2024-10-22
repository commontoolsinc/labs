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

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const jsonFiles = Array.from(files).filter(file => file.type === 'application/json');

      if (jsonFiles.length > 0) {
        Promise.all(jsonFiles.map(file => this.readFileAsJson(file)))
          .then(contents => {
            this.jsonContent = { items: contents };
            this.dispatchEvent(new CustomEvent('common-data', { detail: this.jsonContent }));
          })
          .catch(error => {
            console.error('Error parsing JSON:', error);
          });
      }
    }
  }

  private readFileAsJson(file: File): Promise<any> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = JSON.parse(event.target?.result as string);
          resolve(content);
        } catch (error) {
          reject(error);
        }
      };
      reader.readAsText(file);
    });
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
