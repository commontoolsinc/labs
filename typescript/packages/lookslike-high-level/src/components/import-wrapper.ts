import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('common-import')
export class CommonFileImporter extends LitElement {
  @state() private importedContent: object | null = null;
  @state() private draggedFilesCount: number = 0;

  static override styles = css`
    :host {
      display: block;
      position: relative;
    }
    :host(.dragover)::after {
      content: '';
      position: absolute;
      top: 10px;
      left: 10px;
      right: 10px;
      bottom: 10px;
      background-color: rgba(240, 240, 240, 0.5);
      border: 2px dashed #999;
      border-radius: 10px;
      pointer-events: none;
    }
    .import-message {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 16px;
      color: #666;
      pointer-events: none;
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
    this.draggedFilesCount = e.dataTransfer?.items.length || 0;
    this.requestUpdate();
  }

  private onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.classList.remove('dragover');
    this.draggedFilesCount = 0;
    this.requestUpdate();
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    this.classList.remove('dragover');
    this.draggedFilesCount = 0;

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      Promise.all(Array.from(files).map(file => this.readFile(file)))
        .then(contents => {
          this.importedContent = contents;
          console.log(this.importedContent)
          this.dispatchEvent(new CustomEvent('common-data', { detail: { items: this.importedContent } }));
        })
        .catch(error => {
          console.error('Error processing files:', error);
        });
    }
  }

  private readFile(file: File): Promise<any> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const extension = file.name.split('.').pop()?.toLowerCase();

          if (extension === 'json') {
            resolve(JSON.parse(content));
          } else if (extension === 'txt' || extension === 'md') {
            resolve({
              title: file.name,
              content: content,
              extension: extension
            });
          } else if (extension === 'csv') {
            const rows = content.split('\n').map(row => row.split(','));
            const headers = rows.shift() || [];
            const items = rows
              .filter(row => row.some(cell => cell.trim() !== ''))
              .map(row => {
                const item: { [key: string]: string } = {};
                headers.forEach((header, index) => {
                  item[header.trim()] = row[index]?.trim() || '';
                });
                return item;
              });
            resolve({ items });
          } else if (extension === 'ics') {
            const events = content.split('BEGIN:VEVENT').slice(1).map(event => {
              const lines = event.split('\n');
              return {
                summary: lines.find(line => line.startsWith('SUMMARY:'))?.slice(8),
                dtstart: lines.find(line => line.startsWith('DTSTART:'))?.slice(8),
                dtend: lines.find(line => line.startsWith('DTEND:'))?.slice(6),
                description: lines.find(line => line.startsWith('DESCRIPTION:'))?.slice(12),
                location: lines.find(line => line.startsWith('LOCATION:'))?.slice(9),
              };
            });
            resolve({ events });
          } else if (extension === 'eml') {
            const headers = content.split('\n\n')[0].split('\n');
            const emailObject = {
              from: headers.find(line => line.toLowerCase().startsWith('from:'))?.slice(5).trim(),
              to: headers.find(line => line.toLowerCase().startsWith('to:'))?.slice(3).trim(),
              subject: headers.find(line => line.toLowerCase().startsWith('subject:'))?.slice(8).trim(),
              date: headers.find(line => line.toLowerCase().startsWith('date:'))?.slice(5).trim(),
              body: content.split('\n\n').slice(1).join('\n\n').trim(),
            };
            resolve(emailObject);
          } else {
            reject(new Error('Unsupported file type'));
          }
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
          <slot></slot>
          ${this.draggedFilesCount > 0 ? html`
            <div class="import-message">
              Import ${this.draggedFilesCount} file${this.draggedFilesCount > 1 ? 's' : ''}?
            </div>
          ` : ''}
        </div>
    `;
  }
}
