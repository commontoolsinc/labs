import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { RendererCell } from "@commontools/common-runner";

@customElement("common-draggable")
export default class DraggableElement extends LitElement {
  static override styles = css`
    .draggable {
      position: relative;
    }

    .draggable-scrim {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2;
      display: none;
    }

    .draggable.dragging .draggable-scrim {
      display: block;
      cursor: move;
    }
  `;

  @state() _altKey = false;
  @property({ type: Object }) entity: RendererCell<any> | undefined = undefined;
  @property({ type: Object }) spell: string | undefined = undefined;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.#handleKeyDown);
    window.addEventListener("keyup", this.#handleKeyUp);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.#handleKeyDown);
    window.removeEventListener("keyup", this.#handleKeyUp);
  }

  override render() {
    const classes = classMap({ dragging: this._altKey, draggable: true });

    return html`
      <div
        draggable="true"
        @dragstart=${this.#handleDragStart}
        class=${classes}
      >
        <div class="draggable-scrim"></div>
        <slot></slot>
      </div>
    `;
  }

  #handleKeyDown = (e: KeyboardEvent) => {
    if (e.altKey) {
      this._altKey = true;
    }
  };

  #handleKeyUp = (e: KeyboardEvent) => {
    if (!e.altKey) {
      this._altKey = false;
    }
  };

  #handleDragStart(e: DragEvent) {
    console.log("draggable dragstart", e, this.entity, this.spell);
    const entityId = this.entity?.entityId;

    if (entityId) {
      // TODO: Replace with something more unique
      const data = JSON.stringify({
        ...this.entity?.getAsCellReference(),
        ...(this.spell ? { spell: this.spell } : {}),
      });
      console.log("draggable data", data, e.dataTransfer);
      e.dataTransfer?.setData("application/json", data);
    }
  }
}
