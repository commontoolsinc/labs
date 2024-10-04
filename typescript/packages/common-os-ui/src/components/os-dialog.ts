import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";
import { classMap } from "lit/directives/class-map.js";

@customElement("os-dialog")
export class OsDialog extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --input-height: calc(var(--u) * 14);
        --width: calc(var(--u) * 150);
        --offset: calc(var(--u) * 34);
        display: block;
      }

      /* Creates a fixed position layer on top of the existing layers */
      .layer {
        transition: opacity var(--dur-sm) var(--ease-out-cubic);
        display: block;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        top: 0;
        z-index: 100;
      }

      .layer-hide {
        opacity: 0;
        pointer-events: none;
      }

      .dialog {
        --pad: calc(var(--u) * 4);
        background-color: var(--bg);
        border: 0;
        border-radius: calc((var(--input-height) / 2) + var(--pad));
        padding: var(--pad) var(--pad) calc(var(--pad) * 2);
        box-shadow: var(--shadow-menu);
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        position: absolute;
        overflow: hidden;
        max-width: var(--width);
        margin: 0 auto;
        top: var(--offset);
        left: var(--pad);
        right: var(--pad);
        z-index: 2;
      }

      .scrim {
        background-color: var(--bg-scrim);
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        top: 0;
        z-index: 1;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;

  override connectedCallback(): void {
    window.addEventListener("keydown", this.#onEsc);
    super.connectedCallback();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("keydown", this.#onEsc);
  }

  #onEsc = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.open = false;
    }
  };

  override render() {
    const closeDialog = () => {
      this.open = false;
    };

    const layerClasses = classMap({
      layer: true,
      "layer-hide": !this.open,
    });

    return html`
      <div class="${layerClasses}" @closedialog=${closeDialog}>
        <div class="scrim" @click=${closeDialog}></div>
        <div role="dialog" class="dialog" ?open=${open}><slot></slot></div>
      </div>
    `;
  }
}

export class CloseDialogEvent extends Event {
  constructor() {
    super("closedialog", {
      bubbles: true,
      composed: true,
    });
  }
}
