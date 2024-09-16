import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import { style } from "@commontools/common-ui";
import { render } from "@commontools/common-html";
import { Gem, ID, UI, NAME } from "../data.js";
import { CellImpl, isCell, gemById } from "@commontools/common-runner";

@customElement("common-window-manager")
export class CommonWindowManager extends LitElement {
  static override styles = [
    style.baseStyles,
    css`
      :host {
        display: flex;
        overflow-x: auto;
        overflow-y: visible;
        width: 100%;
        height: 95vh;
        padding: 20px 0; /* Add vertical padding */
      }
      .window {
        flex: 0 0 auto;
        width: 25%;
        min-width: 300px;
        height: 95%; /* Make the window full height */
        margin-left: 20px;
        margin-bottom: 20px;
        border: 1px solid #e0e0e0;
        border-radius: var(--radius);
        background-color: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(10px);
        box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1), 0 6px 6px rgba(0, 0, 0, 0.1),
          0 0 0 1px rgba(0, 0, 0, 0.05);
        transition: all 0.3s ease;
        overflow: hidden;
      }
      .close-button {
        z-index: 1;
        position: absolute;
        top: 8px;
        right: 8px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: rgba(0, 0, 0, 0.1);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        color: rgba(0, 0, 0, 0.4);
        font-weight: bold;
        transition: all 0.2s ease;
      }
      .close-button:hover {
        background-color: rgba(0, 0, 0, 0.15);
        color: rgba(0, 0, 0, 0.6);
      }
      @keyframes highlight {
        0%,
        100% {
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1),
            0 6px 6px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.05);
        }
        50% {
          box-shadow: 0 0 20px 5px rgba(255, 215, 0, 0.5),
            0 6px 6px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.05);
        }
      }
      .highlight {
        animation: highlight 1s ease-in-out;
      }
    `,
  ];

  @property({ type: Array })
  sagas: CellImpl<Gem>[] = [];

  private sagaRefs: Map<number, Ref<HTMLElement>> = new Map();
  private newSagaRefs: [CellImpl<Gem>, Ref<HTMLElement>][] = [];

  override render() {
    return html`
      ${this.sagas.map((saga) => {
        const sagaValues = saga.getAsProxy();
        const sagaId = sagaValues[ID];

        // Create a new ref for this saga
        let sagaRef = this.sagaRefs.get(sagaId);
        if (!sagaRef) {
          sagaRef = createRef<HTMLElement>();
          this.sagaRefs.set(sagaId, sagaRef);
          this.newSagaRefs.push([saga, sagaRef]);
        }

        return html`
          <div class="window" id="window-${sagaId}">
            <button class="close-button" @click="${this.onClose}">×</button>
            <common-screen-element>
              <common-system-layout>
                <div ${ref(sagaRef)}></div>
                <div slot="secondary"><common-annotation .query=${
                  sagaValues[NAME] ?? ""
                } .target=${sagaId} .data=${sagaValues} ></common-annotation></div>
                <common-unibox slot="search" value="" placeholder="" label=">">
              </common-system-layout>
            </common-screen-element>
          </div>
        `;
      })}
    `;
  }

  openSaga(sagaId: number) {
    const saga = gemById.get(sagaId) as CellImpl<Gem>;
    if (!isCell(saga)) throw new Error(`Saga ${sagaId} doesn't exist`);

    const existingWindow = this.renderRoot.querySelector(`#window-${sagaId}`);
    if (existingWindow) {
      this.scrollToAndHighlight(sagaId, true);
      return;
    }

    this.sagas = [...this.sagas, saga];
    this.updateComplete.then(() => {
      while (this.newSagaRefs.length > 0) {
        const [saga, sagaRef] = this.newSagaRefs.pop()!;
        const view = saga.asSimpleCell<Gem>().key(UI).get();
        if (!view) throw new Error("Saga has no UI");
        render(sagaRef.value!, view);
      }

      this.scrollToAndHighlight(sagaId, false);
    });
  }

  private scrollToAndHighlight(sagaId: number, animate: boolean) {
    const window = this.renderRoot.querySelector(`#window-${sagaId}`);
    if (window) {
      window.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "start",
      });
      if (animate) {
        window.classList.add("highlight");
        setTimeout(() => window.classList.remove("highlight"), 1000);
      }
    }
  }

  onClose(e: Event) {
    const windowElement = (e.currentTarget as HTMLElement).closest(".window");
    if (windowElement) {
      const sagaId = parseInt(windowElement.id.replace("window-", ""), 10);
      this.sagas = this.sagas.filter(
        (saga) => saga.getAsProxy()[ID] !== sagaId
      );
      this.sagaRefs.delete(sagaId);
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("open-saga", this.handleAddWindow);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("open-saga", this.handleAddWindow);
  }

  private handleAddWindow(e: Event) {
    const sagaId = (e as CustomEvent).detail.sagaId;
    this.openSaga(sagaId);
  }
}
