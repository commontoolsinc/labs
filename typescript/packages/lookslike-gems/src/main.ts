import { createRxDatabase, addRxPlugin } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { html, render } from "lit-html";
import { RxDBStatePlugin } from "rxdb/plugins/state";
import { Observable, Subscription } from "rxjs";
import { LitElement, css } from "lit-element";
import { customElement, property, state } from "lit-element/decorators.js";

addRxPlugin(RxDBStatePlugin);
// addRxPlugin(RxDBDevModePlugin);

// Define the schema for your database
const schema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: {
      type: "string",
      maxLength: 100,
    },
    value: {
      type: "object",
    },
  },
  required: ["id", "value"],
};

// Create the database
async function createDatabase() {
  const db = await createRxDatabase({
    name: "inventorydb",
    storage: getRxStorageMemory(),
  });

  await db.addCollections({
    inventory: {
      schema: schema,
    },
  });

  return db;
}

@customElement("data-gem")
class DataGem extends LitElement {
  @property({ type: String }) key!: string;
  @property({ type: String }) path!: string;

  @state() private value: any;
  @state() private wobble: boolean = false;
  @state() private showTooltip: boolean = false;
  @state() private tooltipX: number = 0;
  @state() private tooltipY: number = 0;

  static styles = css`
    :host {
      display: block;
      position: relative;
      aspect-ratio: 1 / 1;
    }
    .data-orb {
      background-color: rgba(0, 100, 200, 0.7);
      border-radius: 50%;
      padding: 20px;
      text-align: center;
      color: white;
      transition: transform 0.3s ease;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
    }
    .data-orb.navigable {
      cursor: pointer;
    }
    .data-orb:hover {
      transform: scale(1.1);
    }
    .data-orb.animate {
      animation: wobble 0.3s ease-in-out;
    }
    @keyframes wobble {
      0% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.1);
      }
      100% {
        transform: scale(1);
      }
    }
    .tooltip {
      position: fixed;
      display: block;
      background-color: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 10px;
      border-radius: 5px;
      font-family: monospace;
      font-size: 12px;
      white-space: pre-wrap;
      z-index: 1000;
      max-width: 300px;
      pointer-events: none;
      text-align: left;
    }

    .tooltip-content {
      margin: 0;
      padding: 0;
    }

    .navigate {
      cursor: pointer;
      text-decoration: underline;
      color: blue;
    }
  `;
  subscription: Subscription | null = null;

  private bindValue() {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    const value$ = appState.get$(this.path);
    this.subscription = value$.subscribe((newValue) => {
      const path = `${this.path}`;
      console.log("New value for", path, newValue);
      this.value = newValue;
      this.wobble = true;
      this.requestUpdate();
      setTimeout(() => {
        this.wobble = false;
        this.requestUpdate();
      }, 300);
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    this.bindValue();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has("path")) {
      this.bindValue();
    }
  }

  override render() {
    return html`
      <div
        class="data-orb ${this.wobble ? "animate" : ""} ${this.isNavigable()
          ? "navigable"
          : ""}"
        @mousemove="${this.handleMouseMove}"
        @mouseenter="${this.handleMouseEnter}"
        @mouseleave="${this.handleMouseLeave}"
        @click="${this.handleNavigate}"
      >
        <h3>${this.key}</h3>
        <p>${this.getShortValue()}</p>
      </div>
      ${this.showTooltip ? this.renderTooltip() : ""}
    `;
  }

  isNavigable() {
    return typeof this.value === "object" && this.value !== null;
  }

  handleNavigate() {
    if (!this.isNavigable()) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { key: this.key, value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  renderTooltip() {
    return html`
      <div
        class="tooltip"
        style="left: ${this.tooltipX}px; top: ${this.tooltipY}px"
      >
        <div class="tooltip-content">${this.getPrettyPrintedValue()}</div>
      </div>
    `;
  }

  handleMouseMove(e: MouseEvent) {
    this.tooltipX = e.clientX + 10; // Offset from cursor
    this.tooltipY = e.clientY + 10;
    this.requestUpdate();
  }

  handleMouseEnter() {
    this.showTooltip = true;
  }

  handleMouseLeave() {
    this.showTooltip = false;
  }

  getShortValue(): string {
    if (typeof this.value === "object" && this.value !== null) {
      return Array.isArray(this.value)
        ? `[${this.value.length} items]`
        : "{...}";
    }
    return String(this.value);
  }

  getPrettyPrintedValue(): string {
    return JSON.stringify(this.value, null, 2).trim();
  }
}

const initial = {
  health: 100,
  mana: 50,
  gold: 1000,
  items: ["sword", "shield"],
  skills: {
    strength: 10,
    agility: 8,
    intelligence: 12,
  },
  quests: ["Defeat the dragon", "Find the treasure"],
  level: 5,
};

type Inventory = typeof initial;

type NavigationItem = {
  key: string;
};

@customElement("inventory-view")
class InventoryView extends LitElement {
  @state() private navigationStack: NavigationItem[] = [];

  static styles = css`
    .inventory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 20px;
      padding: 20px;
    }
    .breadcrumb {
      margin-bottom: 10px;
    }
    .breadcrumb-item {
      cursor: pointer;
      color: blue;
      text-decoration: underline;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.navigateTo({ key: "inventory" });
  }

  navigateTo(item: NavigationItem) {
    this.navigationStack = [...this.navigationStack, item];
  }

  navigateBack(index: number) {
    this.navigationStack = this.navigationStack.slice(0, index + 1);
  }

  renderBreadcrumbs() {
    return html`
      <div class="breadcrumb">
        ${this.navigationStack.map(
          (item, index) => html`
            <span
              class="breadcrumb-item"
              @click=${() => this.navigateBack(index)}
            >
              ${item.key}
            </span>
            ${index < this.navigationStack.length - 1 ? " > " : ""}
          `,
        )}
      </div>
    `;
  }

  override render() {
    const currentItem = this.navigationStack[this.navigationStack.length - 1];
    const path = this.navigationStack.map((item) => item.key).join(".");
    const currentValue = appState.get(path);

    return html`
      ${this.renderBreadcrumbs()}
      <div class="inventory-grid">
        ${Object.entries(currentValue).map(([key, value]) => {
          const fullPath = isNaN(key) ? `${path}.${key}` : `${path}[${key}]`;
          return html`
            <data-gem
              .key=${key}
              .path=${fullPath}
              @navigate=${(e: CustomEvent) => this.navigateTo(e.detail)}
            ></data-gem>
          `;
        })}
      </div>
    `;
  }
}

// Main application
async function main(state: any) {
  // Initial render
  render(html`<inventory-view></inventory-view>`, document.body);

  // Example of updating state
  setInterval(() => {
    state.set("inventory.health", (v) => Math.max(0, v - 10));
  }, 1000);

  setInterval(() => {
    state.set("inventory.gold", (v) => v + 50);
  }, 2000);

  setInterval(() => {
    state.set("inventory.skills.intelligence", (v) =>
      Math.round(Math.random() * 20),
    );
  }, 500);
}

let appState = null;

document.addEventListener("DOMContentLoaded", async () => {
  const db = await createDatabase();
  appState = await db.addState();

  // Insert some initial data
  await appState.set("inventory", (_) => initial);

  main(appState).catch(console.error);
});
