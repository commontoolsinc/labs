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
import { NAME } from "@commontools/common-builder";

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
  private charmLookup: Map<string, CellImpl<Charm>> = new Map();

  @state() private focusedCharm: CellImpl<Charm> | null = null;
  @state() private focusedProxy: Charm | null = null;

  handleUniboxSubmit(event: CustomEvent) {
    const charm = this.focusedProxy;

    const value = event.detail.value;
    const shiftKey = event.detail.shiftKey;
    console.log("Unibox submitted:", value, shiftKey);

    if (charm) {
      if (shiftKey) {
        this.focusedCharm
          ?.asSimpleCell(["addToPrompt"])
          .send({ prompt: value } as any);
      } else {
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

  @state() sidebarTab: string = "prompt";
  @state() prompt: string = "";
  @state() data: string = "";
  @state() src: string = "";
  @state() schema: string = "";
  @state() query: string = "";
  @state() suggestions: any[] = [];

  subscriptions: ((() => void) | undefined)[] = [];

  onLocationClicked(_event: CustomEvent) {
    console.log("Location clicked in app.");
    this.searchOpen = true;
  }

  override render() {
    const onCloseDialog = () => {
      this.searchOpen = false;
    };

    // Unsubscribe from previous subscriptions
    this.subscriptions.forEach((unsub) => unsub?.());
    // Log how many subscriptions were cancelled
    console.log(`Cancelled ${this.subscriptions.length} subscriptions`);

    this.subscriptions.length = 0;

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<string>(["prompt"])?.sink((prompt) => {
        this.prompt = prompt;
      }),
    );

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<any>(["data"])?.sink((data) => {
        this.data = JSON.stringify(this.focusedProxy?.data, null, 2);
      }),
    );

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<string>(["src"])?.sink((src) => {
        this.src = src;
      }),
    );

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<string>(["partialHTML"])?.sink((src) => {
        this.src = src;
      }),
    );

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<string>(["schema"])?.sink((schema) => {
        this.schema = JSON.stringify(this.focusedProxy?.schema, null, 2);
      }),
    );

    this.subscriptions.push(
      this.focusedCharm?.asSimpleCell<string>(["query"])?.sink((query) => {
        this.query = JSON.stringify(this.focusedProxy?.query, null, 2);
      }),
    );

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
      this.location = event.detail.value;
      this.searchOpen = false;
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
          detail: { value: prompt, behavior, shiftKey: true },
        }),
      );
    };

    const sidebarNav = html`
      <os-icon-button
        slot="toolbar-end"
        icon="message"
        @click=${() => {
          this.sidebarTab = "prompt";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="query_stats"
        @click=${() => {
          this.sidebarTab = "query";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="database"
        @click=${() => {
          this.sidebarTab = "data";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="code"
        @click=${() => {
          this.sidebarTab = "source";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="schema"
        @click=${() => {
          this.sidebarTab = "schema";
        }}
      ></os-icon-button>
      <os-sidebar-close-button slot="toolbar-end"></os-sidebar-close-button>
    `;

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
            ${repeat(
              Array.from(this.charmLookup.entries()),
              ([id, charm]) => id,
              ([id, charm]) => html`
                <os-charm-chip
                  icon=${charm.getAsProxy().icon || "search"}
                  text=${charm.getAsProxy()[NAME] || "Untitled"}
                  @click=${() => this.openCharm(id)}
                ></os-charm-chip>
              `,
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

            return html`
              <div
                class="window"
                id="window-${charmId}"
                data-charm-id="${JSON.stringify(charmId)}"
              >
                <button class="close-button" @click="${this.onClose}">×</button>
                <div style="height: 100%" ${ref(charmRef)}></div>
              </div>
            `;
          },
        )}

        <os-navstack slot="sidebar">
          ${this.sidebarTab === "query"
            ? html`<os-navpanel safearea>
                ${sidebarNav}
                <os-sidebar-group>
                  <div slot="label">Query</div>
                  <div slot="content">
                    <pre style="white-space: pre-wrap;">${this.query}</pre>
                  </div>
                </os-sidebar-group>
              </os-navpanel>`
            : html``}
          ${this.sidebarTab === "schema"
            ? html`<os-navpanel safearea>
                ${sidebarNav}
                <os-sidebar-group>
                  <div slot="label">Schema</div>
                  <div slot="content">
                    <pre style="white-space: pre-wrap;">${this.schema}</pre>
                  </div>
                </os-sidebar-group>
              </os-navpanel>`
            : html``}
          ${this.sidebarTab === "source"
            ? html`<os-navpanel safearea>
                ${sidebarNav}
                <os-sidebar-group>
                  <div slot="label">Source</div>
                  <div slot="content">
                    <pre style="white-space: pre-wrap;">${this.src}</pre>
                  </div>
                </os-sidebar-group>
              </os-navpanel>`
            : html``}
          ${this.sidebarTab === "data"
            ? html`<os-navpanel safearea>
                ${sidebarNav}
                <os-sidebar-group>
                  <div slot="label">Data</div>
                  <div slot="content">
                    <pre style="white-space: pre-wrap;">${this.data}</pre>
                  </div>
                </os-sidebar-group>
              </os-navpanel>`
            : html``}
          ${this.sidebarTab === "prompt"
            ? html`<os-navpanel safearea>
                ${sidebarNav}
                <os-sidebar-group>
                  <div slot="label">Prompt</div>
                  <div slot="content">
                    <pre style="white-space: pre-wrap;">${this.prompt}</pre>
                  </div>
                </os-sidebar-group>
              </os-navpanel>`
            : html``}
        </os-navstack>
      </os-chrome>
    `;
  }

  openCharm(charmId: string) {
    const charm = getCellByEntityId<Charm>(charmId);
    this.focusedProxy = charm?.getAsProxy() ?? null;
    this.focusedCharm = charm ?? null;
    if (!isCell(charm)) throw new Error(`Charm ${charmId} doesn't exist`);

    addCharms([charm]); // Make sure any shows charm is in the list of charms

    const existingWindow = this.renderRoot.querySelector(
      `[data-charm-id="${CSS.escape(charmId)}"]`,
    );
    if (existingWindow) {
      this.scrollToAndHighlight(charmId, true);
      return;
    }

    this.charms = [charm];
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
