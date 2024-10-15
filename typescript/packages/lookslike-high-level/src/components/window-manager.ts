import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import { style } from "@commontools/common-ui";
import { render } from "@commontools/common-html";
import { Charm, UI, addCharms } from "../data.js";
import {
  run,
  CellImpl,
  isCell,
  getCellByEntityId,
} from "@commontools/common-runner";
import { repeat } from "lit/directives/repeat.js";
import { iframe } from "../recipes/iframe.js";
import { search } from "../recipes/search.js";

@customElement("common-window-manager")
export class CommonWindowManager extends LitElement {
  static override styles = [
    style.baseStyles,
    css`
      :host {
        width: 100%;
      }
      .window {
        height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        container-type: size;
        padding: var(--pad);
        background-color: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
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

      .pin-br {
        position: absolute;
        right: 0;
        bottom: 0;
      }
    `,
  ];

  @property({ type: Array })
  charms: CellImpl<Charm>[] = [];

  private charmRefs: Map<string, Ref<HTMLElement>> = new Map();
  private newCharmRefs: [CellImpl<Charm>, Ref<HTMLElement>][] = [];
  private charmLookup: Map<string, CellImpl<Charm>> = new Map();

  @state() private focusedCharm: string = "-";

  handleUniboxSubmit(event: CustomEvent) {
    const charm = this.charmLookup.get(this.focusedCharm);

    const value = event.detail.value;
    const shiftKey = event.detail.shiftKey;
    console.log("Unibox submitted:", value, shiftKey);

    if (charm?.getAsProxy()) {
      if (shiftKey) {
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

        const eid = run(iframe, {
          data: fieldsToInclude,
          title: value,
          prompt: value,
        }).entityId!;
        this.openCharm(JSON.stringify(eid));
      }
    } else {
      const eid = run(iframe, {
        data: {},
        title: value,
        prompt: value,
      }).entityId!;
      this.openCharm(JSON.stringify(eid));
    }
  }

  input: string = "";

  @state() searchOpen: boolean = false;
  @state() location: string = "Home";
  @state() sidebar: string = "";

  onLocationClicked(_event: CustomEvent) {
    console.log("Location clicked in app.");
    this.searchOpen = true;
  }

  override render() {
    const onCloseDialog = () => {
      this.searchOpen = false;
    };

    const onSearchSubmit = (event: CustomEvent) => {
      console.log("Search submitted:", event.detail.value);
      this.location = event.detail.value;
      this.searchOpen = false;
      const charm = run(search, {
        collection: event.detail.value,
      });
      this.openCharm(JSON.stringify(charm.entityId));

      this.focusedCharm = JSON.stringify(charm.entityId);
    };

    const onAiBoxSubmit = (event: CustomEvent) => {
      console.log("AI Box submitted:", event.detail.value);
      this.handleUniboxSubmit(event);
    };

    return html`
      <os-chrome
        locationtitle=${this.location}
        @location=${this.onLocationClicked}
      >
        <os-dialog .open=${this.searchOpen} @closedialog=${onCloseDialog}>
          <os-ai-box
            @submit=${onSearchSubmit}
            placeholder="Search or imagine..."
          ></os-ai-box>
          <os-charm-chip-group>
            <os-charm-chip icon="mail" text="Mail"></os-charm-chip>
            <os-charm-chip icon="mail" text="Work"></os-charm-chip>
            <os-charm-chip icon="calendar_month" text="Calendar">
            </os-charm-chip>
            <os-charm-chip icon="map" text="Bike and rail directions">
            </os-charm-chip>
            <os-charm-chip icon="cloud" text="Weather"> </os-charm-chip>
            <os-charm-chip icon="folder" text="CHEM131"> </os-charm-chip>
            <os-charm-chip icon="folder" text="Class notes"> </os-charm-chip>
            <os-charm-chip icon="folder" text="Creative writing">
            </os-charm-chip>
          </os-charm-chip-group>
        </os-dialog>

        <os-fabgroup class="pin-br" slot="overlay" @submit=${onAiBoxSubmit}>
          <os-bubble icon="add" text="Lorem ipsum dolor sit amet"></os-bubble>
          <os-bubble icon="note" text="Sumer et"></os-bubble>
        </os-fabgroup>

        ${repeat(
          this.charms,
          (charm) => charm.entityId!.toString(),
          (charm) => {
            const charmId = charm.entityId!;

            // Create a new ref for this charm
            let charmRef = this.charmRefs.get(JSON.stringify(charmId));
            if (!charmRef) {
              charmRef = createRef<HTMLElement>();
              this.charmRefs.set(JSON.stringify(charmId), charmRef);
              this.newCharmRefs.push([charm, charmRef]);
            }

            return html`
              <div
                class="window"
                id="window-${charmId}"
                data-charm-id="${JSON.stringify(charmId)}"
              >
                <button class="close-button" @click="${this.onClose}">×</button>
                <div ${ref(charmRef)}></div>
              </div>
            `;
          }
        )}

        <div slot="sidebar">${this.focusedCharm}</div>
      </os-chrome>
    `;
  }

  openCharm(charmId: string) {
    this.focusedCharm = charmId;
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
    this.charmLookup.set(charmId, charm);
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
        this.charmLookup.delete(charmId);
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
