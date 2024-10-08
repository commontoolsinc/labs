import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import { style } from "@commontools/common-ui";
import { render } from "@commontools/common-html";
import { Charm, UI, NAME, addCharms } from "../data.js";
import {
  run,
  CellImpl,
  isCell,
  getCellByEntityId,
} from "@commontools/common-runner";
import { repeat } from "lit/directives/repeat.js";
import { iframe } from "../recipes/iframe.js";
import { queryCollections } from "../recipes/queryCollections.js";

@customElement("common-window-manager")
export class CommonWindowManager extends LitElement {
  static override styles = [
    style.baseStyles,
    css`
      :host {
        /* display: flex;
        overflow-x: auto;
        overflow-y: visible; */
        width: 100%;
      }
      .window {
        height: 100%;
        flex: 1 1 auto;
        border: 1px solid #e0e0e0;
        border-radius: var(--radius);
        background-color: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(10px);
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
          box-shadow:
            0 10px 20px rgba(0, 0, 0, 0.1),
            0 6px 6px rgba(0, 0, 0, 0.1),
            0 0 0 1px rgba(0, 0, 0, 0.05);
        }
        50% {
          box-shadow:
            0 0 20px 5px rgba(255, 215, 0, 0.5),
            0 6px 6px rgba(0, 0, 0, 0.1),
            0 0 0 1px rgba(0, 0, 0, 0.05);
        }
      }
      .highlight {
        animation: highlight 1s ease-in-out;
      }
    `,
  ];

  @property({ type: Array })
  charms: CellImpl<Charm>[] = [];

  private charmRefs: Map<string, Ref<HTMLElement>> = new Map();
  private newCharmRefs: [CellImpl<Charm>, Ref<HTMLElement>][] = [];

  handleUniboxSubmit(event: CustomEvent, charm: CellImpl<Charm>) {
    const value = event.detail.value;
    const shiftHeld = event.detail.shiftHeld;
    console.log("Unibox submitted:", value);

    if (shiftHeld) {
      charm.asSimpleCell(["addToPrompt"]).send({ prompt: value } as any);
    } else {
      const charmValues = charm.getAsProxy();
      let fieldsToInclude = Object.entries(charmValues).reduce(
        (acc, [key, value]) => {
          if (!key.startsWith("$") && !key.startsWith("_")) {
            acc[key] = value;
          }
          return acc;
        },
        {} as any
      );

      if (charmValues.data) {
        fieldsToInclude = charmValues.data;
      }

      this.openCharm(
        JSON.stringify(
          run(iframe, {
            data: fieldsToInclude,
            title: value,
            prompt: value,
          }).entityId
        )
      );
    }
  }

  input: string = "";

  @state() searchOpen: boolean = false;
  @state() location: string = "Home";

  onLocationClicked(event: CustomEvent) {
    console.log("Location clicked in app.");
    this.searchOpen = true;
  }

  override render() {
    return html`
      ${repeat(
        this.charms,
        (charm) => JSON.stringify(charm.entityId),
        (charm) => {
          const charmValues = charm.getAsProxy();
          const charmId = charm.entityId;

          if (!charmId) throw new Error("Charm has no entity ID");

          // Create a new ref for this charm
          let charmRef = this.charmRefs.get(JSON.stringify(charmId));
          if (!charmRef) {
            charmRef = createRef<HTMLElement>();
            this.charmRefs.set(charmId.toString(), charmRef);
            this.newCharmRefs.push([charm, charmRef]);
          }

          const onCloseDialog = () => {
            this.searchOpen = false;
          };

          const onSubmit = (event: CustomEvent) => {
            console.log("Search submitted:", event.detail.value);
            this.location = event.detail.value;
            this.searchOpen = false;
            launch(queryCollections, { collection: event.detail.value });
          };

          return html`
            <os-chrome locationtitle=${this.location} @location=${this.onLocationClicked}>
                <os-dialog .open=${this.searchOpen} @closedialog=${onCloseDialog}>
                  <os-ai-box @submit=${onSubmit} placeholder="Search or imagine..."></os-ai-box>
                  <os-charm-chip-group>
                    <os-charm-chip icon="mail" text="Mail"></os-charm-chip>
                    <os-charm-chip icon="mail" text="Work"></os-charm-chip>
                    <os-charm-chip icon="calendar_month" text="Calendar"> </os-charm-chip>
                    <os-charm-chip icon="map" text="Bike and rail directions">
                    </os-charm-chip>
                    <os-charm-chip icon="cloud" text="Weather"> </os-charm-chip>
                    <os-charm-chip icon="folder" text="CHEM131"> </os-charm-chip>
                    <os-charm-chip icon="folder" text="Class notes"> </os-charm-chip>
                    <os-charm-chip icon="folder" text="Creative writing"> </os-charm-chip>
                  </os-charm-chip-group>
                </os-dialog>
                <slot name="main">
                    <div class="window" id="window-${charmId}">
                    <button class="close-button" @click="${this.onClose}">×</button>
                    <common-screen-element>
                        <common-system-layout>
                        <div ${ref(charmRef)}></div>
                        <div slot="secondary"><common-annotation .query=${
                          charmValues[NAME] ?? ""
                        } .target=${charmId} .data=${charmValues} ></common-annotation></div>
                        <common-unibox slot="search" value=${this.input} @submit=${(e) => this.handleUniboxSubmit(e, charm)} placeholder="" label=">">
                        </common-system-layout>
                    </common-screen-element>
                    </div>
                </slot>
            </os-chrome>
          `;
        },
      )}
    `;
  }

  openCharm(charmId: string) {
    const charm = getCellByEntityId<Charm>(charmId);
    if (!isCell(charm)) throw new Error(`Charm ${charmId} doesn't exist`);

    addCharms([charm]); // Make sure any shows charm is in the list of charms

    const existingWindow = this.renderRoot.querySelector(
      `[data-charm-id="${CSS.escape(charmId)}"]`
    );
    if (existingWindow) {
      this.scrollToAndHighlight(charmId, true);
      return;
    }

    this.charms = [...this.charms, charm];
    this.updateComplete.then(() => {
      while (this.newCharmRefs.length > 0) {
        const [charm, charmRef] = this.newCharmRefs.pop()!;
        const view = charm.asSimpleCell<Charm>().key(UI).get();
        if (!view) throw new Error("Charm has no UI");
        render(charmRef.value!, view);
      }

      this.scrollToAndHighlight(charmId, false);
    });
  }

  private scrollToAndHighlight(charmId: string, animate: boolean) {
    const window = this.renderRoot.querySelector(
      `[data-charm-id="${CSS.escape(charmId)}"]`
    );
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
      const charmId = windowElement.getAttribute("data-charm-id");
      if (charmId) {
        this.charms = this.charms.filter(
          (charm) => JSON.stringify(charm.entityId) !== charmId
        );
        this.charmRefs.delete(charmId);
      }
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("open-charm", this.handleAddWindow);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("open-charm", this.handleAddWindow);
  }

  private handleAddWindow(e: Event) {
    const charmId = (e as CustomEvent).detail.charmId;
    this.openCharm(charmId);
  }
}
