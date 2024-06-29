import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";
import * as THREE from "three";

const styles = css``;

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

    function addVoxel(
      scene: THREE.Scene,
      x: number,
      y: number,
      z: number,
      color: THREE.Color
    ) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshBasicMaterial({ color: color });
      const voxel = new THREE.Mesh(geometry, material);
      voxel.position.set(x, y, z);
      scene.add(voxel);
    }

    const test = (scene: THREE.Scene) => {
      this.voxelData.forEach((voxel) => {
        addVoxel(
          scene,
          voxel.position[0],
          voxel.position[1],
          voxel.position[2],
          voxel.color
        );
      });
    };

    return html`
      <com-data .data=${JSON.stringify(this.value)}></com-data>
      <com-scene .create=${test}></com-scene>
    `;
  }
}
