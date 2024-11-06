import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import { style } from "@commontools/common-ui";
import { render } from "@commontools/common-html";
import {
  Charm,
  UI,
  addCharms,
  runPersistent,
  syncCharm,
  openCharm,
} from "../data.js";
import {
  run,
  CellImpl,
  isCell,
  idle,
  EntityId,
} from "@commontools/common-runner";
import { repeat } from "lit/directives/repeat.js";
import { iframe } from "../recipes/iframe.js";
import { search } from "../recipes/search.js";
import { NAME } from "@commontools/common-builder";
import { matchRoute, navigate } from "../router.js";
import { inferJsonSchema } from "../schema.js";
import { schemaQueryExample } from "../recipes/schemaQuery.jsx";

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

      .empty-state {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        height: 100%;
        opacity: 0.25;
        user-select: none;
        pointer-events: none;
      }
    `,
  ];

  private charms: CellImpl<Charm>[] = [];
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
          ?.asRendererCell(["addToPrompt"])
          .send({ prompt: value } as any);
      } else {
        // // ben: this is a hack to access the data designer from search (temporarily)
        // if (charm.data && charm.query) {
        //   const eid = run(dataDesigner, {
        //     data: charm.data,
        //     prompt: value,
        //     title: value,
        //   }).entityId!;
        //   this.openCharm(JSON.stringify(eid));
        // }

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

        runPersistent(iframe, {
          data: fieldsToInclude,
          title: value,
          prompt: value,
        }).then((charm) => this.openCharm(charm));
      }
    } else {
      // there is no existing data
      runPersistent(iframe, {
        data: {},
        title: value,
        prompt: value,
      }).then((charm) => this.openCharm(charm));
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

  onHome(_event: CustomEvent) {
    window.location.pathname = "/";
  }

  override render() {
    const onCloseDialog = () => {
      this.searchOpen = false;
    };

    this.focusedCharm
      ?.asRendererCell()
      .key("suggestions")
      ?.sink((suggestions) => {
        const s = suggestions?.items;
        if (!s) return;

        this.suggestions = s;
        console.log("suggest", this.suggestions);
      });

    const onSearchSubmit = (event: CustomEvent) => {
      console.log("Search submitted:", event.detail.value);
      this.searchOpen = false;
      this.input = "";
      runPersistent(search, {
        search: event.detail.value,
      }).then((charm) => this.openCharm(charm));
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
          detail: {
            value: "- " + prompt,
            behavior,
            shiftKey: behavior === "fork",
          },
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

    const onImportLocalData = (event: CustomEvent) => {
      const data = event.detail.data;
      console.log("Importing local data:", data);

      if (event.detail.shiftKey && this.focusedCharm) {
        const existingData = this.focusedProxy?.data || {};
        const mergedData = { ...existingData };

        for (const [key, value] of Object.entries(data)) {
          if (Array.isArray(value) && Array.isArray(existingData[key])) {
            mergedData[key] = [...existingData[key], ...value];
          } else {
            mergedData[key] = value;
          }
        }

        this.focusedCharm.asRendererCell(["data"]).send(mergedData);

        // Update the title to indicate the merge
        const newTitle = `${
          this.focusedProxy?.[NAME] || "Untitled"
        } (Merged ${new Date().toISOString()})`;
        this.focusedCharm.asRendererCell([NAME]).send(newTitle);

        // Refresh the UI
        this.requestUpdate();
      } else {
        // Create a new charm and query for the imported data
        const schema = inferJsonSchema(data[0]);
        runPersistent(schemaQueryExample, { schema }).then((charm) =>
          this.openCharm(charm),
        );
      }
    };

    return html`
      <common-xxx-import @common-data=${onImportLocalData}>
        <os-chrome
          ?wide=${this.wideSidebar}
          locationtitle=${this.focusedProxy?.[NAME] || "Untitled"}
          @location=${this.onLocationClicked}
        >
          <os-avatar
            slot="toolbar-start"
            name="Ben"
            .onclick=${this.onHome}
          ></os-avatar>

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
                  if (!charm.get()) return;

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
                    icon=${charm.getAsQueryResult().icon || "search"}
                    text=${charm.getAsQueryResult()[NAME] || "Untitled"}
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
              Array.isArray(this.suggestions) ? this.suggestions : [],
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
          ${this.charms.length === 0
            ? html`
                <div class="empty-state">
                  <div style="display: flex; align-items: center;">
                    <os-ai-icon></os-ai-icon>
                    <p style="margin-left: 10px;">Imagine or import to begin</p>
                  </div>
                </div>
              `
            : html``}
          ${repeat(
            this.charms,
            (charm) => charm.entityId!.toString(),
            (charm) => {
              if (!charm.get()) return;

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
                      ${charm.getAsQueryResult()[NAME]}
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
      </common-xxx-import>
    `;
  }

  async openCharm(charmToOpen: string | EntityId | CellImpl<any>) {
    const charm = await syncCharm(charmToOpen);
    const charmId = JSON.stringify(charm.entityId!);
    await idle();
    run(undefined, undefined, charm);
    if (!isCell(charm)) throw new Error(`Charm ${charmId} doesn't exist`);
    this.focusedCharm = charm;
    this.focusedProxy = charm?.getAsQueryResult();

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
        const view = charm.asRendererCell<Charm>().key(UI);
        if (!view.getAsQueryResult()) throw new Error("Charm has no UI");
        render(charmRef.value!, view);
        this.requestUpdate();
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

    console.log(
      "onroutechange",
      JSON.stringify(this.focusedCharm?.entityId),
      match?.params.charmId,
    );
    if (
      match &&
      JSON.stringify(this.focusedCharm?.entityId) !== match.params.charmId
    ) {
      // TODO: Add a timeout here, show loading state and error state
      setTimeout(() => {
        syncCharm(match.params.charmId, true).then(
          (charm) => charm && charm.get() && this.openCharm(charm),
        );
      }, 100);
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("open-charm", this.handleAddWindow);
    window.addEventListener("routeChange", this.#onRouteChange.bind(this));
    this.#onRouteChange(
      new CustomEvent("routeChange", { detail: window.location.href }),
    );
    openCharm.set(this.openCharm.bind(this));
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
