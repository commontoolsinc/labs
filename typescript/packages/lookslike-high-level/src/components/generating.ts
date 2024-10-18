import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('ascii-art-loading-animation')
export class CommonGenerating extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #ccc;
      font-family: monospace;
    }

    .ascii-art {
      white-space: pre;
      font-size: 16px;
      line-height: 1;
      padding: 1rem;
      max-width: 600px;
      max-height: 400px;
      overflow: auto;
      margin-bottom: 1rem;
    }

    .progress-text {
      color: white;
      margin-bottom: 0.5rem;
    }

    input[type="range"] {
      width: 16rem;
    }
  `;

  @property({ type: Number }) progress = 0;
  @state() private grid: string[][] = [];
  @state() private time = 0;

  private characters = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
  private rows = 20;
  private cols = 40;
  private overlayText = "COMMONOS";
  private intervalId?: number;



  override connectedCallback() {
    super.connectedCallback();
    this.intervalId = setInterval(() => {
      this.time = ((this.time + (1 + this.progress / 2.0))) % 100;
      this.generateGrid();
    }, 50);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('progress')) {
      this.generateGrid();
    }
  }

  private generateGrid() {
    const newGrid: string[][] = [];
    const startRow = Math.floor(this.rows / 2) - 2;
    const startCol = Math.floor((this.cols - this.overlayText.length) / 2) - 2;
    const endRow = startRow + 4;
    const endCol = startCol + this.overlayText.length + 3;

    for (let y = 0; y < this.rows; y++) {
      const row: string[] = [];
      for (let x = 0; x < this.cols; x++) {
        if (y >= startRow && y <= endRow && x >= startCol && x <= endCol) {
          if (y === startRow || y === endRow) {
            row.push(x === startCol || x === endCol ? '+' : '-');
          } else if (x === startCol || x === endCol) {
            row.push('|');
          } else if (y === startRow + 2 && x > startCol + 1 && x <= startCol + this.overlayText.length + 1) {
            row.push(this.overlayText[x - startCol - 2]);
          } else {
            row.push(' ');
          }
        } else {
          const distance = Math.sqrt(x * x + y * y);
          const maxDistance = Math.sqrt(this.cols * this.cols + this.rows * this.rows);
          const normalizedDistance = distance / maxDistance;

          const threshold = (((this.time) / 100.0) + normalizedDistance) % 1;
          const intensityFactor = Math.min(this.progress * 2, 1);
          const adjustedThreshold = threshold * intensityFactor;

          const index = Math.floor(adjustedThreshold * this.characters.length);

          row.push(this.characters[Math.min(index, this.characters.length - 1)]);
        }
      }
      newGrid.push(row);
    }
    this.grid = newGrid;
  }

  override render() {
    return html`
      <div class="ascii-art">${this.grid.map(row => html`${row.join('')}\n`)}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ascii-art-loading-animation': CommonGenerating;
  }
}
