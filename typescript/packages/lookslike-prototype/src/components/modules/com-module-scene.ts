import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import * as THREE from "three";

const styles = css``;

class VoxelRenderer {
  private instancedMesh: THREE.InstancedMesh | null = null;
  private tempColor = new THREE.Color();
  private tempMatrix = new THREE.Matrix4();

  constructor(
    private voxelData: { position: number[]; color: THREE.Color | number }[]
  ) {}

  initInstancedMesh(scene: THREE.Scene) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();

    this.instancedMesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.voxelData.length
    );

    const colorArray = new Float32Array(this.voxelData.length * 3);
    this.instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
      colorArray,
      3
    );

    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.instancedMesh);

    this.updateInstancedMesh();
  }

  updateInstancedMesh() {
    if (!this.instancedMesh) return;

    for (let i = 0; i < this.voxelData.length; i++) {
      const voxel = this.voxelData[i];

      // Handle different color representations
      if (voxel.color instanceof THREE.Color) {
        this.tempColor.copy(voxel.color);
      } else {
        this.tempColor.set(voxel.color);
      }

      this.instancedMesh.setColorAt(i, this.tempColor);
      this.tempMatrix.setPosition(
        voxel.position[0],
        voxel.position[1],
        voxel.position[2]
      );
      this.instancedMesh.setMatrixAt(i, this.tempMatrix);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  update(scene: THREE.Scene) {
    if (!this.instancedMesh) {
      this.initInstancedMesh(scene);
    } else {
      this.updateInstancedMesh();
    }
  }
}

@customElement("com-module-scene")
export class ComModuleScene extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = [];
  voxelData: { position: [number, number, number]; color: number }[] = [
    { position: [0, 0, 0], color: 0xff0000 },
    { position: [1, 0, 0], color: 0x00ff00 },
    { position: [0, 1, 0], color: 0x0000ff },
    { position: [1, 1, 0], color: 0xffff00 },
    { position: [0, 0, 1], color: 0xff00ff },
    { position: [1, 0, 1], color: 0x00ffff },
    { position: [0, 1, 1], color: 0xffffff },
    { position: [1, 1, 1], color: 0x808080 }
  ];

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("value")) {
      if (this.value.length) {
        this.voxelData = this.value;
      }
      this.requestUpdate();
    }
  }

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    const codeChanged = (ev: CustomEvent) => {
      if (!this.node) return;

      this.node.body = ev.detail.code;
      const event = new CustomEvent("updated", {
        detail: {
          body: this.node.body
        }
      });
      this.dispatchEvent(event);
    };

    const test = (scene: THREE.Scene) => {
      const voxelRenderer = new VoxelRenderer(this.voxelData);
      console.log("render voxels");
      voxelRenderer.update(scene);
    };

    return html`
      <com-data .data=${JSON.stringify(this.value)}></com-data>
      <com-scene .create=${test}></com-scene>
    `;
  }
}
