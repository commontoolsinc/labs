import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { RendererCell } from "@commontools/common-runner";

@customElement("common-draggable")
export default class DraggableElement extends LitElement {
  @property({ type: Object }) entity: RendererCell<any> | undefined = undefined;

  override render() {
    return html`
      <div draggable="true" @dragstart=${this.handleDragStart}>
        <div>Drag me</div>

        <slot></slot>
      </div>
    `;
  }

  private handleDragStart(e: DragEvent) {
    console.log("draggable dragstart", e, this.entity);
    const entityId = this.entity?.entityId;

    if (entityId) {
      // TODO: Replace with something more unique
      const data = JSON.stringify(this.entity?.getAsCellReference());
      console.log("draggable data", data, e.dataTransfer);
      e.dataTransfer?.setData("application/json", data);
    }
  }
}
