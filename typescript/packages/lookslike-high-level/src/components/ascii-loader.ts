import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('common-ascii-loader')
export class CommonAsciiLoader extends LitElement {
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
      font-size: 24px;
      line-height: 1;
      padding: 1rem;
      max-width: 1024px;
      max-height: 1024px;
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

  private rows = 32;
  private cols = 80;
  private overlayText = "COMMON";
  private intervalId?: number;

  override connectedCallback() {
    super.connectedCallback();
    this.intervalId = setInterval(() => {
      this.time = (this.time + 0.1) % 512;
      this.generateGrid();
    }, 33);
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

  private warpedTime() {
    return this.time * (1 + this.progress);
  }

  private generateGrid() {
    const newGrid: string[][] = [];
    const startRow = Math.floor(this.rows / 2) - 2;
    const startCol = Math.floor((this.cols - this.overlayText.length) / 2) - 2;
    const endRow = startRow + 4;
    const endCol = startCol + this.overlayText.length + 3;
    let characters = [' ', '.', '·', ':', '∙', '°', '⋅', '•', '◦', '⁘', '⁙', '⁚', '⁛', '⁜', '⁝', '⁞', '‥', '…'];

    for (let y = 0; y < this.rows; y++) {
      const row: string[] = [];
      for (let x = 0; x < this.cols; x++) {
          const distance = Math.sqrt(x * x + y * y);
          const maxDistance = Math.sqrt(this.cols * this.cols + this.rows * this.rows);
          const normalizedDistance = distance / maxDistance;

          // Add noise
          const noise = this.perlinNoise(x * 0.1, y * 0.1, this.warpedTime() * 0.01);

          // Domain warping
          const warpX = x + Math.sin(y * 0.1 + this.warpedTime() * 0.05) * 2;
          const warpY = y + Math.cos(x * 0.1 + this.warpedTime() * 0.05) * 2;

          const warpedDistance = Math.sqrt(warpX * warpX + warpY * warpY);
          const warpedNormalizedDistance = warpedDistance / maxDistance;

          const threshold = (((this.warpedTime()) / 100.0) + warpedNormalizedDistance + noise * 0.2) % 1;
          const intensityFactor = Math.min(this.progress * 2 + 0.05, 1);
          const adjustedThreshold = threshold * intensityFactor;

          const index = Math.floor(adjustedThreshold * characters.length);

          row.push(characters[Math.min(index, characters.length - 1)]);
      }
      newGrid.push(row);
    }
    this.grid = newGrid;
  }

  private perlinNoise(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;

    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);

    const u = this.fade(x);
    const v = this.fade(y);
    const w = this.fade(z);

    const A = this.p[X] + Y, AA = this.p[A] + Z, AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y, BA = this.p[B] + Z, BB = this.p[B + 1] + Z;

    return this.lerp(w, this.lerp(v, this.lerp(u, this.grad(this.p[AA], x, y, z),
      this.grad(this.p[BA], x - 1, y, z)),
      this.lerp(u, this.grad(this.p[AB], x, y - 1, z),
        this.grad(this.p[BB], x - 1, y - 1, z))),
      this.lerp(v, this.lerp(u, this.grad(this.p[AA + 1], x, y, z - 1),
        this.grad(this.p[BA + 1], x - 1, y, z - 1)),
        this.lerp(u, this.grad(this.p[AB + 1], x, y - 1, z - 1),
          this.grad(this.p[BB + 1], x - 1, y - 1, z - 1))));
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  private grad(hash: number, x: number, y: number, z: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  private p = new Array(512);

  constructor() {
    super();
    const permutation = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
    for (let i = 0; i < 256; i++) {
      this.p[256 + i] = this.p[i] = permutation[i];
    }
  }

  override render() {
    return html`
      <div class="ascii-art">${this.grid.map(row => html`${row.join('')}\n`)}</div>
    `;
  }
}
