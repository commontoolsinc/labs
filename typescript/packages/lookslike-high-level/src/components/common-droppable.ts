import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import {
  getCellByEntityId,
  isGettable,
  isSendable,
  RendererCell,
} from "@commontools/common-runner";
import { openCharm } from "../data.js";
@customElement("common-droppable")
export default class DroppableElement extends LitElement {
  @property({ type: Object }) droppable: RendererCell<any[]> | undefined;
  @property({ type: Object }) schema: RendererCell<any> | undefined;
  @property({ type: Object }) opentarget: RendererCell<any> | undefined;

  private _hoverTimeout: number | undefined;
  private _openedTarget: boolean = false;

  override render() {
    return html`
      <div
        @dragover=${this.#handleDragOver}
        @drop=${this.#handleDrop}
        @dragleave=${this.#handleDragLeave}
        @dragenter=${this.#handleDragEnter}
      >
        <slot></slot>
      </div>
    `;
  }

  #handleDragOver(e: DragEvent) {
    if (
      this.droppable &&
      isSendable(this.droppable) &&
      // Cell is either a stream cell (no get) or it is not undefined. Set
      // initialy value to `null` to differentiate from non-existing (which is
      // what undefined means).
      (!isGettable(this.droppable) || this.droppable.get() !== undefined)
    ) {
      // TODO: check schema
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    }
  }

  #handleJsonDrop(data: string) {
    const parsedData = JSON.parse(data);

    // TODO: Either replace with something more unique or traverse
    if (
      typeof parsedData === "object" &&
      parsedData !== null &&
      parsedData.cell
    ) {
      const cell = getCellByEntityId(parsedData.cell, false);
      if (cell) parsedData.cell = cell;
    }

    return parsedData;
  }

  #handleDrop(e: DragEvent) {
    console.log("droppable drop", e);
    e.preventDefault();
    if (this._hoverTimeout) clearTimeout(this._hoverTimeout);

    if (!e.dataTransfer?.items || !this.droppable) return;

    const items: any[] = [];

    // Iterate through all items
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.type.startsWith("application/json")) {
        item.getAsString((data: any) => {
          if (!data) return;

          const parsedData = this.#handleJsonDrop(data);

          if (parsedData !== undefined) items.push(parsedData);
        });
      } else if (item.type.startsWith("text/plain")) {
        item.getAsString((data) => {
          if (data !== undefined) items.push(data);
        });
      }
    }

    if (items.length === 0 && e.dataTransfer.getData("application/json")) {
      items.push(
        this.#handleJsonDrop(e.dataTransfer.getData("application/json")),
      );
    }

    if (items.length === 0 && e.dataTransfer.getData("text/plain")) {
      items.push(e.dataTransfer.getData("text/plain"));
    }

    console.log("droppable", items);
    if (items.length > 0) this.droppable.send(items);

    if (this.opentarget && !this._openedTarget)
      openCharm(this.opentarget!.getAsCellReference().cell);
  }

  #handleDragLeave(e: DragEvent) {
    e.preventDefault();
    console.log("on leave", this._openedTarget, this.opentarget);
    if (this._hoverTimeout) {
      clearTimeout(this._hoverTimeout);
      this._hoverTimeout = undefined;
    }
  }

  #handleDragEnter(e: DragEvent) {
    e.preventDefault();
    console.log("on enter", this._openedTarget, this.opentarget);
    if (!this.opentarget) return;

    if (this._hoverTimeout) clearTimeout(this._hoverTimeout);

    this._hoverTimeout = setTimeout(() => {
      console.log("hover timeout", this._openedTarget, this.opentarget);
      if (this._openedTarget || !this.opentarget) return;
      this._openedTarget = true;
      openCharm(this.opentarget.getAsCellReference().cell);
    }, 1000) as unknown as number;
  }
}
