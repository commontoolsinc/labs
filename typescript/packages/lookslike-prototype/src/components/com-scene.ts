import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

@customElement("com-scene")
export class SceneElement extends LitElement {
  private containerRef: HTMLDivElement | null = null;
  private rendererRef: THREE.WebGLRenderer | null = null;
  private sceneRef: THREE.Scene | null = null;

  @property() create!: (scene: THREE.Scene) => void;

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
  camera!: THREE.PerspectiveCamera;
  controls: any;

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
    if (changedProperties.has("create") && this.sceneRef) {
      this.sceneRef.clear();

      const geometry = new THREE.BoxGeometry();
      const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
      const cube = new THREE.Mesh(geometry, material);
      this.sceneRef.add(cube);

      this.create(this.sceneRef);
    }
  }

  initThreeJS() {
    this.containerRef = this.renderRoot.querySelector(
      ".container"
    ) as HTMLDivElement;
    if (!this.containerRef) return;

    this.sceneRef = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.z = 5;

    // add light
    const light = new THREE.PointLight(0xffffff, 10);
    light.position.set(1, 1, 1).normalize();
    this.sceneRef.add(light);

    const renderer = new THREE.WebGLRenderer();
    renderer.setClearColor(0x00000000);
    this.rendererRef = renderer;
    renderer.setSize(
      this.containerRef.clientWidth,
      this.containerRef.clientHeight
    );
    this.containerRef.appendChild(renderer.domElement);
    this.controls = new OrbitControls(this.camera, renderer.domElement);

    this.create(this.sceneRef);

    const animate = () => {
      if (this.sceneRef) {
        renderer.render(this.sceneRef, this.camera);
      }
      this.controls.update();

      requestAnimationFrame(animate);
    };
    animate();
    this.handleResize();
  }

  handleResize = () => {
    if (this.containerRef && this.rendererRef) {
      const { clientWidth, clientHeight } = this.containerRef;
      this.camera.aspect = clientWidth / clientHeight;
      this.camera.updateProjectionMatrix();
      this.rendererRef.setSize(clientWidth, clientHeight);
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
