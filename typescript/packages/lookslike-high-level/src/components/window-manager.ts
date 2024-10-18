import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { style } from "@commontools/common-ui";
import { render } from "@commontools/common-html";
import { Charm, UI, addCharms, recipes } from "../data.js";
import {
  run,
  CellImpl,
  isCell,
  getCellByEntityId,
  cell,
} from "@commontools/common-runner";
import { repeat } from "lit/directives/repeat.js";
import { iframe } from "../recipes/iframe.js";
import { search } from "../recipes/search.js";
import { NAME } from "@commontools/common-builder";
import { dataDesigner } from "../recipes/dataDesigner.js";
import { matchRoute, navigate } from "../router.js";
import { watchCell } from "../watchCell.js";

@customElement("os-charm-chip-wrapper")
export class CharmChipWrapper extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: inline-block;
    }
    .close-button {
      position: absolute;
      top: -5px;
      right: -5px;
      width: 16px;
      height: 16px;
      background-color: #ff4444;
      color: white;
      border: none;
      border-radius: 50%;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      z-index: 1;
    }
    .badge {
      position: absolute;
      top: -5px;
      left: -5px;
      background-color: #4444ff;
      color: white;
      border-radius: 50%;
      padding: 2px 5px;
      font-size: 10px;
      z-index: 1;
    }
  `;

  @property({ type: Number })
  override id: number = 0;

  override render() {
    return html`
      <div>
        <button class="close-button" @click=${this.handleClose}>×</button>
        <span class="badge">${this.id}</span>
        <slot></slot>
      </div>
    `;
  }

  handleClose(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleKeyPress);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.handleKeyPress);
  }

  private handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === this.id.toString()) {
      this.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
        }),
      );
    }
  };
}

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
        width: 100%;
        flex: 1 1 auto;
        overflow-x: hidden;
        overflow-y: auto;
        background-color: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
        transition: max-height 0.3s ease;
        position: relative;
      }

      .window-toolbar {
        position: absolute;
        top: 0;
        left: 0;
        right: 8px;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        height: 32px;
        pointer-events: none;
      }

      .window-toolbar > * {
        pointer-events: auto;
      }

      .window.minimized {
        max-height: 32px;
        display: none;
      }

      .window.minimized .charm {
        display: none;
      }

      .window .charm {
        height: 100%;
      }

      .window-title {
        font-family: monospace;
        font-size: 0.8rem;
        cursor: pointer;
        display: none;
      }

      .window.minimized .window-title {
        color: rgba(0, 0, 0, 0.4);
      }

      .close-button {
        z-index: 1;
        height: 16px;
        width: 16px;
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
        flex: 0 0 auto;
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

  @state() private focusedCharm: CellImpl<Charm> | null = null;
  @state() private focusedProxy: Charm | null = null;

  handleUniboxSubmit(event: CustomEvent) {
    const charm = this.focusedProxy;

    const value = event.detail.value;
    const shiftKey = event.detail.shiftKey;
    console.log("Unibox submitted:", value, shiftKey);

    if (charm) {
      // modify in place by default, if possible
      if (!shiftKey && charm.addToPrompt) {
        this.focusedCharm
          ?.asSimpleCell(["addToPrompt"])
          .send({ prompt: value } as any);

        // holding shift will fork
      } else {
        // ben: this is a hack to access the data designer from search (temporarily)
        if (charm.data && charm.query) {
          const eid = run(dataDesigner, {
            data: charm.data,
            prompt: value,
            title: value,
          }).entityId!;
          this.openCharm(JSON.stringify(eid));
        }

        // pass data forward to new charm
        const charmValues = charm;
        let fieldsToInclude = Object.entries(charmValues).reduce(
          (acc, [key, value]) => {
            if (!key.startsWith("$") && !key.startsWith("_")) {
              acc[key] = value;
            }
            return acc;
          },
          {} as any,
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
      // there is no existing data
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

  @state() sidebarTab: string = "home";
  @state() wideSidebar: boolean = false;
  @state() suggestions: any[] = [];

  onLocationClicked(_event: CustomEvent) {
    console.log("Location clicked in app.");
    this.searchOpen = true;
  }

  override render() {
    const onCloseDialog = () => {
      this.searchOpen = false;
    };

    this.focusedCharm
      ?.asSimpleCell<any>(["suggestions"])
      ?.sink((suggestions) => {
        const s = this.focusedProxy?.suggestions?.items;
        if (!s) return;

        this.suggestions = s;
        console.log("suggest", this.suggestions);
      });

    const onSearchSubmit = (event: CustomEvent) => {
      console.log("Search submitted:", event.detail.value);
      this.searchOpen = false;
      this.input = "";
      const charm = run(search, {
        search: event.detail.value,
      });
      this.openCharm(JSON.stringify(charm.entityId));
    };

    const onAiBoxSubmit = (event: CustomEvent) => {
      console.log("AI Box submitted:", event.detail.value);
      this.handleUniboxSubmit(event);
    };

    const onSuggestionsSelected = ({
      prompt,
      behavior,
    }: {
      prompt: string;
      behavior: string;
    }) => {
      console.log("Suggestion selected:", prompt, behavior);
      this.handleUniboxSubmit(
        new CustomEvent("submit", {
          detail: { value: prompt, behavior, shiftKey: behavior === "fork" },
        }),
      );
    };

    const onSidebarTabChanged = (event: CustomEvent) => {
      this.sidebarTab = event.detail.tab;
      this.wideSidebar =
        this.sidebarTab === "source" ||
        this.sidebarTab === "data" ||
        this.sidebarTab === "query";
    };

    return html`
      <os-chrome
        ?wide=${this.wideSidebar}
        locationtitle=${this.location}
        @location=${this.onLocationClicked}
      >
        <os-avatar slot="toolbar-start" name="Ben"></os-avatar>

        <os-dialog .open=${this.searchOpen} @closedialog=${onCloseDialog}>
          <os-ai-box
            @submit=${onSearchSubmit}
            placeholder="Search or imagine..."
          ></os-ai-box>

          <os-charm-chip-group>
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

                const onNavigate = () => {
                  this.openCharm(JSON.stringify(charmId));
                  this.searchOpen = false;
                };

                return html` <os-charm-chip
                  icon=${charm.getAsProxy().icon || "search"}
                  text=${charm.getAsProxy()[NAME] || "Untitled"}
                  .highlight=${JSON.stringify(charm.entityId) ===
                  JSON.stringify(this.focusedCharm?.entityId)}
                  @click=${onNavigate}
                ></os-charm-chip>`;
              },
            )}
          </os-charm-chip-group>
        </os-dialog>

        <os-fabgroup class="pin-br" slot="overlay" @submit=${onAiBoxSubmit}>
          ${repeat(
            this.suggestions,
            (suggestion) => suggestion.prompt,
            (suggestion) => html`
              <os-bubble
                icon=${suggestion.behavior === "fork" ? "call_split" : "add"}
                text=${suggestion.prompt}
                @click=${() => onSuggestionsSelected(suggestion)}
              ></os-bubble>
            `,
          )}
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

            const onNavigate = () => {
              this.openCharm(JSON.stringify(charmId));
            };

            return html`
              <div
                class="window ${JSON.stringify(charm.entityId) !==
                JSON.stringify(this.focusedCharm?.entityId)
                  ? "minimized"
                  : ""}"
                id="window-${charmId}"
                data-charm-id="${JSON.stringify(charmId)}"
              >
                <div class="window-toolbar">
                  <h1 class="window-title" @click=${onNavigate}>
                    ${charm.getAsProxy()[NAME]}
                  </h1>
                  <button class="close-button" @click="${this.onClose}">
                    ×
                  </button>
                </div>
                <div class="charm" ${ref(charmRef)}></div>
              </div>
            `;
          },
        )}

        <os-navstack slot="sidebar">
          <common-sidebar
            .focusedProxy=${this.focusedProxy}
            .focusedCharm=${this.focusedCharm}
            sidebarTab=${this.sidebarTab}
            @tab-changed=${onSidebarTabChanged}
          >
          </common-sidebar>
        </os-navstack>
      </os-chrome>
    `;
  }

  openCharm(charmId: string) {
    const charm = getCellByEntityId<Charm>(charmId);
    this.focusedProxy = charm?.getAsProxy() ?? null;
    this.focusedCharm = charm ?? null;
    if (!isCell(charm)) throw new Error(`Charm ${charmId} doesn't exist`);

    addCharms([charm]);
    this.location = this.focusedProxy?.[NAME] || "-";

    const existingWindow = this.renderRoot.querySelector(
      `[data-charm-id="${CSS.escape(charmId)}"]`,
    );
    if (existingWindow) {
      this.scrollToAndHighlight(charmId, true);
      return;
    } else {
      navigate(`/charm/${charmId}`);
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
      `[data-charm-id="${CSS.escape(charmId)}"]`,
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
          (charm) => JSON.stringify(charm.entityId) !== charmId,
        );
        this.charmRefs.delete(charmId);
      }
    }
  }

  #onRouteChange(e: Event) {
    const customEvent = e as CustomEvent;
    console.log("routeChange", customEvent.detail);
    const match = matchRoute(
      "/charm/:charmId",
      new URL(customEvent.detail, window.location.href),
    );
    console.log(new URL(customEvent.detail, window.location.href));
    console.log(match);

    if (
      match &&
      JSON.stringify(this.focusedCharm?.entityId) !== match.params.charmId
    ) {
      this.openCharm(match.params.charmId);
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("open-charm", this.handleAddWindow);
    window.addEventListener("routeChange", this.#onRouteChange.bind(this));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("open-charm", this.handleAddWindow);
    window.removeEventListener("routeChange", this.#onRouteChange.bind(this));
  }

  private handleAddWindow(e: Event) {
    const charmId = (e as CustomEvent).detail.charmId;
    this.openCharm(charmId);
  }
}
