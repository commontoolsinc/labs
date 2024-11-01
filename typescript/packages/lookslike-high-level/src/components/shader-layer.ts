import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";

@customElement("shader-layer")
export class ShaderLayer extends LitElement {
  @property({ type: String }) shader = '';
  @property({ type: Number }) width = 640;
  @property({ type: Number }) height = 480;
  @property({ type: String }) blendMode = 'hard-light';

  private canvasRef = createRef<HTMLCanvasElement>();
  private gl?: WebGLRenderingContext;
  private program?: WebGLProgram;
  private timeLocation?: WebGLUniformLocation;
  private resolutionLocation?: WebGLUniformLocation;
  private animationFrame?: number;
  private startTime = performance.now();

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      bottom: 0;
    }
    canvas {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      mix-blend-mode: var(--blend-mode, hard-light);
    }
  `;

  private setupWebGL() {
    const canvas = this.canvasRef.value;
    if (!canvas) return;

    canvas.width = this.width;
    canvas.height = this.height;
    canvas.style.setProperty('--blend-mode', this.blendMode);

    this.gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false
    })!;
    if (!this.gl) return;

    // Enable blending for transparency
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    const vertexShader = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vertexShader) return;

    this.gl.shaderSource(vertexShader, `
      attribute vec2 position;
      varying vec2 v_texCoord;
      void main() {
        v_texCoord = (position + 1.0) * 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    this.gl.compileShader(vertexShader);

    const positions = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1
    ]);
    const positionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);

    if (!this.shader) return;

    this.program = this.gl.createProgram();
    if (!this.program) return;

    const fragmentShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!fragmentShader) return;

    this.gl.shaderSource(fragmentShader, this.shader);
    this.gl.compileShader(fragmentShader);

    if (!this.gl.getShaderParameter(fragmentShader, this.gl.COMPILE_STATUS)) {
      console.error('Fragment shader compilation error:', this.gl.getShaderInfoLog(fragmentShader));
      return;
    }

    this.gl.attachShader(this.program, vertexShader);
    this.gl.attachShader(this.program, fragmentShader);
    this.gl.linkProgram(this.program);

    if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
      console.error('Program linking error:', this.gl.getProgramInfoLog(this.program));
      return;
    }

    const positionLocation = this.gl.getAttribLocation(this.program, "position");
    this.gl.enableVertexAttribArray(positionLocation);
    this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0);

    this.timeLocation = this.gl.getUniformLocation(this.program, "iTime");
    this.resolutionLocation = this.gl.getUniformLocation(this.program, "iResolution");
  }

  private renderGl() {
    if (!this.gl || !this.program) return;

    const time = (performance.now() - this.startTime) / 1000;

    this.gl.viewport(0, 0, this.width, this.height);
    this.gl.useProgram(this.program);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    if (this.timeLocation) {
      this.gl.uniform1f(this.timeLocation, time);
    }
    if (this.resolutionLocation) {
      this.gl.uniform2f(this.resolutionLocation, this.width, this.height);
    }

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);

    this.animationFrame = requestAnimationFrame(() => this.renderGl());
  }

  override firstUpdated() {
    this.setupWebGL();
    this.renderGl();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
  }

  override render() {
    return html`
      <canvas ${ref(this.canvasRef)}></canvas>
    `;
  }
}
