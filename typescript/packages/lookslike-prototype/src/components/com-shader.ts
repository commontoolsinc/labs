import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import * as THREE from "three";

const defaultShader = `
  void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      // Normalized pixel coordinates (from 0 to 1)
      vec2 uv = fragCoord / iResolution.xy;

      // Sample the texture from iChannel0
      vec4 texColor = texture(iChannel0, uv);

      // Output the color
      fragColor = vec4(texColor.rgb, 1.0);
  }

  `;

@customElement("com-shader")
export class ShaderElement extends LitElement {
  @property({ type: String }) fragmentShader = "defaultShader";
  @property({ type: Number }) bpm = 60;
  @property() webcam: THREE.VideoTexture | null = null;

  private containerRef: HTMLDivElement | null = null;
  private rendererRef: THREE.WebGLRenderer | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private uniforms: any;

  static styles = css`
    :host {
      display: block;
      position: relative;
    }
    .container {
      width: 100%;
      height: 320px;
    }
    button {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 20;
      background-color: rgba(0, 0, 0, 0.5);
      color: white;
      border: none;
      padding: 5px 10px;
      cursor: pointer;
    }
  `;

  override firstUpdated() {
    this.initThreeJS();
    window.addEventListener("resize", this.handleResize);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
    if (this.containerRef && this.rendererRef?.domElement) {
      this.containerRef.removeChild(this.rendererRef.domElement);
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has("fragmentShader")) {
      this.updateShaderMaterial();
    }
  }

  initThreeJS() {
    this.containerRef = this.renderRoot.querySelector(
      ".container"
    ) as HTMLDivElement;
    if (!this.containerRef) return;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;

    const renderer = new THREE.WebGLRenderer();
    this.rendererRef = renderer;
    renderer.setSize(
      this.containerRef.clientWidth,
      this.containerRef.clientHeight
    );
    this.containerRef.appendChild(renderer.domElement);

    this.uniforms = {
      iTrueTime: { value: 0 },
      iResolution: {
        value: new THREE.Vector3(
          this.containerRef.clientWidth,
          this.containerRef.clientHeight,
          1
        )
      },
      iMouse: { value: new THREE.Vector2() },
      iChannel0: { value: this.webcam }
    };

    this.material = new THREE.ShaderMaterial({
      fragmentShader: this.getFragmentShader(),
      uniforms: this.uniforms
    });

    const plane = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(plane, this.material);
    scene.add(mesh);

    const animate = () => {
      this.uniforms.iTrueTime.value = performance.now() / 1000.0;
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();
    this.handleResize();
  }

  updateShaderMaterial() {
    if (this.material) {
      this.material.fragmentShader = this.getFragmentShader();
      this.material.uniforms.iChannel0.value = this.webcam;
      this.material.needsUpdate = true;
      this.material.uniformsNeedUpdate = true;
    }
  }

  getFragmentShader() {
    return `
      uniform float iTrueTime;
      uniform vec3 iResolution;
      uniform vec2 iMouse;
      uniform sampler2D iChannel0;

      float iTime;
      float alt, lt, atr, tr;
      int bt;
      vec2 asp, asp2;
      float bpm = ${this.bpm}.0;
      void settime(float t) {
        alt = lt = t;
        atr = fract(lt);
        tr = tanh(atr * 5.);
        bt = int(lt);
        lt = tr + float(bt);
      }

      ${this.fragmentShader}

      void main() {
        settime(iTrueTime * bpm / 60.);
        iTime = iTrueTime;
        mainImage(gl_FragColor, gl_FragCoord.xy);
        gl_FragColor.a = 1.0;
      }
    `;
  }

  handleResize = () => {
    if (this.containerRef && this.rendererRef) {
      const { clientWidth, clientHeight } = this.containerRef;
      this.rendererRef.setSize(clientWidth, clientHeight);
      this.uniforms.iResolution.value.set(clientWidth, clientHeight, 1);
    }
  };

  toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      this.containerRef?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  override render() {
    return html`
      <div class="container"></div>
      <button @click="${this.toggleFullScreen}">👁️</button>
    `;
  }
}
