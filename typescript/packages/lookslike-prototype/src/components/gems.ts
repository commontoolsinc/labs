import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Subscription } from "rxjs";
import { graphState } from "../gems.js";

@customElement("data-gem")
export class DataGem extends LitElement {
  @property({ type: String }) key!: string;
  @property({ type: String }) path!: string;

  @state() private value: any;
  @state() private wobble: boolean = false;
  @state() private showTooltip: boolean = false;
  @state() private tooltipX: number = 0;
  @state() private tooltipY: number = 0;

  static override styles = css`
    :host {
      display: block;
      position: relative;
      aspect-ratio: 1 / 1;
    }
    .data-orb {
      background-color: rgba(0, 100, 200, 0.7);
      border-radius: 50%;
      padding: 10px;
      text-align: center;
      font-size: 12px;
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

    .data-orb * {
      padding: 0;
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

    const value$ = graphState.get$(this.path);
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
        <strong><code>${this.key}</code></strong>
        <code>${this.getShortValue()}</code>
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
        composed: true
      })
    );
  }

  renderTooltip() {
    return html`
      <div
        class="tooltip"
        style="left: ${this.tooltipX}px; top: ${this.tooltipY}px"
      >
        <code class="tooltip-content">${this.getPrettyPrintedValue()}</code>
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
  test: "hello"
};

type NavigationItem = {
  key: string;
};

@customElement("inventory-view")
export class InventoryView extends LitElement {
  @state() private navigationStack: NavigationItem[] = [];

  static override styles = css`
    .inventory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
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
    this.navigateTo({ key: "state" });
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
          `
        )}
      </div>
    `;
  }

  override render() {
    const path = this.navigationStack.map((item) => item.key).join(".");
    const currentValue = graphState.get(path);
    console.log("Current value", currentValue);

    const onRefresh = () => {
      this.requestUpdate();
    };

    return html`
      ${this.renderBreadcrumbs()}
      <button @click=${onRefresh}>Refresh</button>
      <div class="inventory-grid">
        ${Object.entries(currentValue).map(([key, _value]) => {
          const fullPath = isNaN(Number(key))
            ? `${path}.${key}`
            : `${path}[${key}]`;
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
