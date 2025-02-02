import { css, html, LitElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { style } from "@commontools/ui";
import { when } from "lit/directives/when.js";
import { Charm, charms, runPersistent } from "@commontools/charm";
import { BLOBBY_SERVER_URL, recipes } from "../data.js"
import {  refer } from "merkle-reference";

import {
  getDoc,
  DocImpl,
  getRecipe,
  isDoc,
  getRecipeParents,
  getRecipeSpec,
  getRecipeSrc,
} from "@commontools/runner";
import { NAME, TYPE, UI } from "@commontools/builder";
import { watchCell } from "../watchCell.js";
import { createRef, ref } from "lit/directives/ref.js";
import { home } from "../recipes/home.jsx";
import { render } from "@commontools/html";
import { saveRecipe } from "../data.js";
import { createNewRecipe } from "./iframe-spell-ai.js";

const uploadBlob = async (data: any) => {
  const id = refer(data).toString();

  await fetch(`${BLOBBY_SERVER_URL}/data-${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
};

// bf: TODO, send a "toast" event on window and an use another element to handle it
const toasty = (message: string) => {
  const toastEl = document.createElement("div");
  toastEl.textContent = message;
  toastEl.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    z-index: 1000;
  `;
  document.body.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 3000);
};

@customElement("common-debug")
export class CommonDebug extends LitElement {
  @property({ type: Object })
  content: any;

  static override styles = css`
    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;

  override render() {
    return html`
      <pre slot="content">
${typeof this.content === "string" ? this.content : JSON.stringify(this.content, null, 2)}</pre
      >
    `;
  }
}

@customElement("common-sidebar")
export class CommonSidebar extends LitElement {
  @property({ type: Object })
  focusedCharm: DocImpl<Charm> | null = null;

  @property({ type: Object })
  focusedProxy: Charm | null = null;

  @property({ type: String })
  sidebarTab: string = "home";

  @property({ type: String })
  compileErrors: string = "";

  @property({ type: String })
  workingSrc: string = "";

  @property({ type: String })
  workingSpec: string = "";

  @property({ type: Object })
  private homeRef = createRef<HTMLElement>();
  private homeCharm: Promise<DocImpl<Charm>> | null = null;
  private linkedCharms: DocImpl<Charm>[] = [];

  static override styles = [
    style.baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
        display: flex;
        flex-direction: column;
      }

      os-navstack {
        flex: 1;
        min-height: 0;
      }

      .panel-container {
        position: relative;
        height: 100%;
        overflow: hidden;
      }

      os-navpanel {
        position: absolute;
        width: 100%;
        height: 100%;
        transition:
          transform 0.1s ease,
          opacity 0.1s ease;
        opacity: 0;
        transform: translateX(15px);
        pointer-events: none;
      }

      os-navpanel.active {
        opacity: 1;
        transform: translateX(0);
        pointer-events: auto;
      }

      os-navpanel.exit {
        opacity: 0;
        transform: translateX(-15px);
      }

      .close-button {
        transition: none;
      }

      .sidebar-content {
        padding: var(--gap-xsm);
        padding-bottom: 0;
        box-sizing: border-box;
      }
    `,
  ];

  private getFieldOrDefault = <T>(field: string, defaultValue: T) =>
    this.focusedCharm?.asCell([field]) || getDoc(defaultValue).asCell();

  private setField = <T>(field: string, value: T) => {
    this.focusedCharm?.asCell([field]).send(value);
  };

  private handleSidebarTabChange(tabName: string) {
    const currentPanel = this.shadowRoot?.querySelector(".active");
    if (currentPanel) {
      currentPanel.classList.add("exit");
      setTimeout(() => {
        currentPanel.classList.remove("exit");
        this.sidebarTab = tabName;
      }, 100); // Match transition duration
    } else {
      this.sidebarTab = tabName;
    }

    const event = new CustomEvent("tab-changed", {
      detail: { tab: tabName },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private async handleDrop() {
    const data = {
      familyName: "Paracosm",
      members: [
        {
          firstName: "Piper",
          lastName: "Paracosm",
          relationship: "Self",
          birthDate: "2000-02-29",
          occupation: "Founder of Emergent Endeavors",
          quirks: [
            "Disappears every four years on a 'cosmic sabbatical'",
            "Practices 'algorithmic origami'",
            "Keeps a journal from her future self's perspective",
            "Hosts monthly 'Collaborative Conjuring' sessions",
          ],
          secretTalent: "Can communicate with plants through interpretive dance",
          favoriteJoke: "Why don't scientists trust atoms? Because they make up everything!",
          embarrassingMoment:
            "Accidentally used chaos theory to predict the cafeteria menu instead of stock market trends during a consulting gig",
          hiddenAspiration: "To become the first urban planner on Mars",
        },
        {
          firstName: "Fern",
          lastName: "Paracosm",
          relationship: "Mother",
          birthDate: "1965-09-12",
          occupation: "Mycologist",
          quirks: [
            "Talks to mushrooms",
            "Wears clothes made entirely of lichen",
            "Insists on using spore-based communication methods",
          ],
          secretTalent: "Can identify any fungus by taste (safely)",
          favoriteJoke: "Why did the mushroom go to the party? Because he was a fun guy!",
          embarrassingMoment:
            "Accidentally grew hallucinogenic mushrooms in the mayor's garden during a city beautification project",
          hiddenAspiration: "To discover a mushroom that can solve differential equations",
        },
        {
          firstName: "Quark",
          lastName: "Paracosm",
          relationship: "Father",
          birthDate: "1963-04-01",
          occupation: "Chaos Theorist",
          quirks: [
            "Refuses to make plans, citing 'unpredictability of complex systems'",
            "Builds elaborate domino setups throughout the house",
            "Communicates primarily through butterfly effect metaphors",
          ],
          secretTalent: "Can predict weather patterns by observing cat behavior",
          favoriteJoke:
            "Why did the chaos theorist cross the road? To create a butterfly effect on the other side!",
          embarrassingMoment:
            "Caused a citywide power outage while trying to model the flapping of a butterfly's wings",
          hiddenAspiration: "To prove that love is the ultimate chaotic attractor",
        },
        {
          firstName: "Binary",
          lastName: "Paracosm",
          relationship: "Sibling",
          birthDate: "1998-01-01",
          occupation: "Quantum Computer Programmer",
          quirks: [
            "Only speaks in binary on odd-numbered days",
            "Insists on quantum entangling their socks",
            "Believes they exist in multiple universes simultaneously",
          ],
          secretTalent: "Can mentally calculate pi to 1000 digits",
          favoriteJoke: "Why do programmers prefer dark mode? Because light attracts bugs!",
          embarrassingMoment:
            "Accidentally quantum entangled their consciousness with a particularly grumpy cat",
          hiddenAspiration: "To program the first AI that can experience existential dread",
        },
      ],
      familyTraditions: [
        {
          name: "Emergence Day",
          description:
            "Annual family gathering where everyone brings a small, seemingly insignificant item to contribute to a massive Rube Goldberg machine",
          frequency: "Yearly",
          origin:
            "Started when Quark's domino setup accidentally triggered a series of unforeseen events that resulted in Piper's college acceptance letter being mailed",
        },
        {
          name: "Mycelial Midnight Feast",
          description:
            "Monthly midnight picnic in the backyard, where all food must contain at least one type of mushroom",
          frequency: "Monthly",
          origin: "Fern's attempt to introduce the family to the 'real' midnight snack",
        },
        {
          name: "Quantum Family Game Night",
          description:
            "Weekly game night where traditional board games are modified with quantum rules (e.g., pieces can exist in superposition)",
          frequency: "Weekly",
          origin: "Binary's effort to make family game night 'more realistic'",
        },
      ],
      familySecrets: [
        "The backyard is actually a small-scale model of a self-sustaining ecosystem for future Mars colonization",
        "Piper's 'cosmic sabbaticals' are actually undercover missions for a secret society of pattern seekers",
        "The family cat is believed to be a transdimensional being that occasionally offers cosmic wisdom",
        "There's a hidden room in the house that can only be accessed by solving a series of increasingly complex logic puzzles",
      ],
      familyHeirloom: {
        name: "The Paracosmic Prism",
        description:
          "A kaleidoscopic crystal that supposedly shows glimpses of alternate realities",
        age: 150,
        value: "Priceless (or worthless, depending on your dimensional perspective)",
        cursed: true,
      },
      familyRecipe: {
        name: "Quantum Quiche of Uncertainty",
        ingredients: [
          "6 Schrödinger eggs (simultaneously raw and cooked)",
          "1 cup of superposition spinach",
          "1/2 cup of entangled cheese",
          "1 pie crust made from non-Euclidean dough",
          "A pinch of quantum foam",
        ],
        instructions: [
          "Preheat oven to a temperature that is both hot and cold",
          "Mix ingredients in a state of quantum superposition",
          "Pour mixture into pie crust while simultaneously not pouring it",
          "Bake for an indeterminate amount of time",
          "Observe quiche to collapse its wave function and determine if it's cooked",
        ],
        secretIngredient: "A dash of Fibonacci-sequence-aligned thyme",
      },
      familyVacationSpot: {
        location: "The Fractal Coast",
        annualDisaster: "Getting lost in a recursively generated beach cave system",
        bestMemory:
          "Discovering a hidden cove that seems to exist in multiple dimensions simultaneously",
      },
    };

    // also posted the data json to blobby ... would spellcaster work with this data?
    uploadBlob(data);

    await createNewRecipe(data, "a simple display of the users data");
  }

  private async handlePublish() {
    const input = prompt("Enter title and #tags for your spell:");
    if (!input) return;

    const tags = (input.match(/#[\w-]+/g) || []).map((tag) => tag.slice(1));
    const title = input.replace(/#[\w-]+/g, "").trim();

    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const src = getRecipeSrc(recipeId) || "";
    const spec = getRecipeSpec(recipeId);
    const parents = getRecipeParents(recipeId);

    const success = await saveRecipe(recipeId, src, spec, parents, title, tags);

    if (success) {
      window.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const spellbookUrl = `https://paas.saga-castor.ts.net/spellbookjr/recipes/spell-${recipeId}`;
      try {
        await navigator.clipboard.writeText(spellbookUrl);
        toasty("Published to Spellbook Jr! Spellbook link copied to clipboard");
      } catch (err) {
        toasty(`Published to Spellbook Jr! Spellbook URL: ${spellbookUrl}`);
        console.error("Failed to copy to clipboard:", err);
      }
    } else {
      toasty("Failed to publish");
    }
  }

  protected override async updated(_changedProperties: PropertyValues): Promise<void> {
    super.updated(_changedProperties);

    if (_changedProperties.has("sidebarTab") && this.homeCharm) {
      this.homeCharm = null;
    }

    if (!this.homeCharm && this.homeRef.value) {
      this.homeCharm = runPersistent(home, { charms, recipes }, "home").then((home) => {
        const view = home.asCell<Charm>().key(UI);
        if (!view.getAsQueryResult()) throw new Error("Charm has no UI");
        render(this.homeRef.value!, view);
        return home;
      });
    }

    if (_changedProperties.has("focusedCharm")) {
      const processCell = this.focusedCharm?.sourceCell?.get();
      if (processCell) {
        const linkedCharms = new Set<DocImpl<Charm>>();
        const traverse = (value: any, parents: any[] = []) => {
          if (isDoc(value)) {
            const initialCell = value;

            while (value.sourceCell) value = value.sourceCell;
            if (value.get()?.resultRef) value = value.get().resultRef.cell;

            if (value !== this.focusedCharm) {
              if (value.get()?.[NAME] && value.get()?.[UI]) {
                linkedCharms.add(value);
              } else {
                console.log("not a charm", initialCell, value.get(), parents);
              }
            }
          } else if (typeof value === "object" && value !== null) {
            for (const key in value) {
              traverse(value[key], [...parents, value]);
            }
          }
        };
        traverse(processCell);
        this.linkedCharms = Array.from(linkedCharms);
      }
    }
  }

  private renderPanel(id: string, content: unknown) {
    return html`
      <os-navpanel class=${this.sidebarTab === id ? "active sidebar-content" : "sidebar-content"}>
        <common-hstack slot="toolbar-end" gap="sm">
          <os-icon-button icon="warning" @click=${() => this.handleDrop()}></os-icon-button>
          ${when(
            this.focusedCharm,
            () => html`
              <os-icon-button icon="publish" @click=${() => this.handlePublish()}></os-icon-button>
            `,
          )}
          <os-sidebar-close-button></os-sidebar-close-button>
        </common-hstack>
        <os-sidebar-group> ${content} </os-sidebar-group>
      </os-navpanel>
    `;
  }

  override render() {
    const data = this.getFieldOrDefault("data", {});
    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const argument = this.focusedCharm?.sourceCell?.getAsQueryResult()?.argument;
    const recipe = getRecipe(recipeId);
    const schema = recipe?.argumentSchema || {};
    const query = this.getFieldOrDefault("query", {});

    const onSpecChanged = (e: CustomEvent) => {
      this.workingSpec = e.detail.state.doc.toString();
    };

    const onQueryChanged = (e: CustomEvent) => {
      try {
        const parsed = JSON.parse(e.detail.state.doc.toString());
        this.setField("query", parsed);
      } catch (err) {
        console.warn("Failed to parse query JSON:", err);
      }
    };

    const onDataChanged = (e: CustomEvent) => {
      try {
        const parsed = JSON.parse(e.detail.state.doc.toString());
        this.setField("data", parsed);
      } catch (err) {
        console.warn("Failed to parse data JSON:", err);
      }
    };

    const copyRecipeLink = (event: Event) => {
      const target = event.target as HTMLAnchorElement;
      navigator.clipboard.writeText(target.href);
      event.preventDefault();
      toasty("Copied recipe link to clipboard");
    };

    const tabs = [
      { id: "home", icon: "home", label: "Home" },
      { id: "prompt", icon: "message", label: "Prompt" },
      { id: "links", icon: "sync_alt", label: "Links" },
      { id: "query", icon: "query_stats", label: "Query" },
      { id: "data", icon: "database", label: "Data" },
      { id: "schema", icon: "schema", label: "Schema" },
      { id: "source", icon: "code", label: "Source" },
      { id: "recipe-json", icon: "data_object", label: "JSON" },
    ];

    const panels = {
      home: html`
        <div slot="label">Pinned</div>
        <div ${ref(this.homeRef)}></div>
      `,
      links: html`
        <div slot="label">Linked Charms</div>
        <div>
          ${this.linkedCharms.map(
            (charm) => html`<common-charm-link .charm=${charm}></common-charm-link>`,
          )}
        </div>
      `,
      query: html`
        <div slot="label">Query</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${watchCell(query, (q) => JSON.stringify(q, null, 2))}
            @doc-change=${onQueryChanged}
          ></os-code-editor>
        </div>
      `,
      schema: html`
        <div slot="label">Schema</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${JSON.stringify(schema, null, 2)}
          ></os-code-editor>
        </div>
      `,
      source: html`
        <div slot="label">
          <div
            style="display: flex; justify-content: space-between; border: 1px solid pink; padding: 10px;"
          >
            <a
              href="/recipe/spell-${recipeId}"
              target="_blank"
              @click=${copyRecipeLink}
              style="float: right"
              class="close-button"
              >🔗 Share</a
            >
            <button @click=${() => this.handlePublish()} class="close-button">
              🪄 Publish to Spellbook Jr
            </button>
          </div>
        </div>
        <div style="margin: 10px;"></div>
        <div>
          <common-spell-editor .recipeId=${recipeId} .data=${argument}></common-spell-editor>
        </div>
      `,
      "recipe-json": html`
        <div slot="label">Recipe JSON</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${JSON.stringify(getRecipe(recipeId), null, 2)}
          ></os-code-editor>
        </div>
      `,
      data: html`
        <div slot="label">
          Data<span
            id="log-button"
            @click=${() => console.log(JSON.stringify(this.focusedCharm?.getAsQueryResult()))}
            class="close-button"
            >log</span
          >
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${watchCell(data, (q) => JSON.stringify(q, null, 2))}
            @doc-change=${onDataChanged}
          ></os-code-editor>
        </div>
      `,
      prompt: html`
        <div slot="label">
          Spec
          <a
            href="/recipe/${recipeId}"
            target="_blank"
            @click=${copyRecipeLink}
            style="float: right"
            class="close-button"
            >🔗 Share</a
          >
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="text/markdown"
            .source=${this.workingSpec}
            @doc-change=${onSpecChanged}
          ></os-code-editor>
        </div>
      `,
    };

    return html`
      <os-navstack>
        <div class="panel-container">
          ${Object.entries(panels).map(([id, content]) => this.renderPanel(id, content))}
        </div>
      </os-navstack>
      <os-tab-bar
        .items=${tabs}
        .selected=${this.sidebarTab}
        @tab-change=${(e: CustomEvent) => this.handleSidebarTabChange(e.detail.selected)}
      ></os-tab-bar>
    `;
  }
}
