import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";

@customElement("shader-layer")
export class ShaderLayer extends LitElement {
  @property({ type: String }) shader = '';
  @property({ type: Number }) width = 640;
  @property({ type: Number }) height = 480;
  @property({ type: String }) blendMode = 'default';
  @property({ type: String, reflect: true }) errorMessage: string | null = null;

  private canvasRef = createRef<HTMLCanvasElement>();
  private gl?: WebGLRenderingContext;
  private program?: WebGLProgram;
  private timeLocation?: WebGLUniformLocation;
  private resolutionLocation?: WebGLUniformLocation;
  private animationFrame?: number;
  private startTime = performance.now();
  private vertexShader?: WebGLShader;

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
      mix-blend-mode: var(--blend-mode, default);
    }
    .error {
      color: red;
      padding: 20px;
      position: absolute;
      top: 0;
      left: 0;
      background: rgba(0,0,0,0.8);
    }
  `;

  private cleanup() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }

    if (this.gl) {
      if (this.program) {
        this.gl.deleteProgram(this.program);
        this.program = undefined;
      }
      if (this.vertexShader) {
        this.gl.deleteShader(this.vertexShader);
        this.vertexShader = undefined;
      }
      this.gl = undefined;
    }

    this.timeLocation = undefined;
    this.resolutionLocation = undefined;
    this.errorMessage = null;
  }

  private setupWebGL() {
    this.cleanup();

    const canvas = this.canvasRef.value;
    if (!canvas) return;

    canvas.width = this.width;
    canvas.height = this.height;
    canvas.style.setProperty('--blend-mode', this.blendMode);

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false
    });
    if (!gl) {
      this.errorMessage = "WebGL not supported";
      this.requestUpdate();
      return;
    }
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (!vertexShader) {
      this.errorMessage = "Failed to create vertex shader";
      this.requestUpdate();
      return;
    }
    this.vertexShader = vertexShader;

    gl.shaderSource(vertexShader, `
      attribute vec2 position;
      varying vec2 v_texCoord;
      void main() {
        v_texCoord = (position + 1.0) * 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      this.errorMessage = `Vertex shader error: ${gl.getShaderInfoLog(vertexShader)}`;
      this.requestUpdate();
      return;
    }

    const positions = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1
    ]);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    this.initShaderProgram();
  }

  private initShaderProgram() {
    if (!this.gl || !this.vertexShader || !this.shader) return;
    const gl = this.gl;

    const program = gl.createProgram();
    if (!program) {
      this.errorMessage = "Failed to create program";
      this.requestUpdate();
      return;
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragmentShader) {
      this.errorMessage = "Failed to create fragment shader";
      this.requestUpdate();
      return;
    }

    gl.shaderSource(fragmentShader, this.shader);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      this.errorMessage = `Fragment shader error: ${gl.getShaderInfoLog(fragmentShader)}`;
      gl.deleteShader(fragmentShader);
      this.requestUpdate();
      return;
    }

    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.errorMessage = `Program linking error: ${gl.getProgramInfoLog(program)}`;
      gl.deleteShader(fragmentShader);
      gl.deleteProgram(program);
      this.requestUpdate();
      return;
    }

    this.program = program;

    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.timeLocation = gl.getUniformLocation(program, "iTime");
    this.resolutionLocation = gl.getUniformLocation(program, "iResolution");

    gl.deleteShader(fragmentShader);

    this.startTime = performance.now();
    this.renderGl();
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

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('shader') ||
        changedProperties.has('width') ||
        changedProperties.has('height') ||
        changedProperties.has('blendMode')) {
      this.setupWebGL();
    }
  }

  override firstUpdated() {
    this.setupWebGL();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  override render() {
    return html`
      <canvas ${ref(this.canvasRef)}></canvas>
      ${this.errorMessage ? html`<div class="error">${this.errorMessage}</div>` : null}
    `;
  }
}
