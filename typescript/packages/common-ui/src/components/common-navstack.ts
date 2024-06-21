import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { view } from "../hyperscript/render.js";
import { styleMap } from "lit/directives/style-map.js";

export const navstack = view('common-navstack', {});

@customElement("common-navstack")
export class CommonNavstackElement extends LitElement {
  static override styles = css`
  :host {
    display: block;
    width: 100%;
    height: 100px;
  }

  .navstack {
    position: relative;
    height: 100%;
    width: 100%;
    overflow-x: clip;
  }

  .navstack ::slotted(*) {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
  }

  .navstack ::slotted(*) {
    background-color: white;
    user-select: none;
  }

  .navstack ::slotted(:not(*:last-child)) {
    pointer-events: none;
  }

  .navstack ::slotted(*:nth-last-child(2)) {
    pointer-events: none;
    background-color: rgb(
      calc(var(--_navstack-move-percent, 1) * 105 + 150),
      calc(var(--_navstack-move-percent, 1) * 105 + 150),
      calc(var(--_navstack-move-percent, 1) * 105 + 150)
    );
    transform: translateX(calc(var(--_navstack-move-percent, 0) * 30px - 30px));
  }
  
  .navstack ::slotted(*:last-child) {
    pointer-events: none;
    transform: translateX(calc(var(--_navstack-x-delta, 0) * 1px));
  }
  `;

  override render() {
    return html`
    <div class="navstack"
      @pointerdown=${this.#onDragStart}
      @pointerup=${this.#stopDrag}
      @pointercancel=${this.#stopDrag}
      @pointerleave=${this.#stopDrag}
      @pointermove=${this.#onDragMove}
      style=${styleMap({
      '--_navstack-x-delta': this.moveDelta,
      '--_navstack-move-percent': this.moveNormalized
    })}
      >
      <slot></slot>
    </div>
    `;
  }

  @state()
  private moveNormalized: number = 0;

  @state()
  private goalDelta: number = 0;

  @state()
  private moving: boolean = false;

  @state()
  private moveStart: number = 0;

  @state()
  private moveDelta: number = 0;

  #onDragStart(e: PointerEvent): void {
    if (this.children.length <= 1) {
      return;
    }
    this.moving = true;
    this.moveStart = e.clientX;
    // Pop stack if moving > 40% of the containing element.
    this.goalDelta = this.getBoundingClientRect().width * 0.40;
  }

  #onDragMove(e: PointerEvent): void {
    if (!this.moving) {
      return;
    }
    this.moveDelta = Math.max(0, e.clientX - this.moveStart);
    this.moveNormalized = Math.max(0, Math.min(1, (this.moveDelta / this.goalDelta)));
    if (this.moveDelta >= this.goalDelta) {
      this.#stopDrag();
      this.popElement();
    }
  }

  #stopDrag(): void {
    this.moving = false;
    this.moveStart = 0;
    this.moveDelta = 0;
    this.moveNormalized = 0;
  }

  popElement(): void {
    let childCount = this.children.length;
    if (childCount === 0) {
      return;
    }
    this.removeChild(this.children[childCount - 1]);
  }

  pushElement(element: HTMLElement): void {
    this.renderRoot.querySelector('slot').appendChild(element);
  }
}