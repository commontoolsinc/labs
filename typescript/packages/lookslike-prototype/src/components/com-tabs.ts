import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";

interface TabItem {
  label: string;
  content: HTMLElement;
}

@customElement("com-tabs")
export class ComTabs extends LitElement {
  @property({ type: Array }) tabs: TabItem[] = [];
  @property({ type: Number }) activeTab = 0;

  static styles = css`
    :host {
      display: block;
    }
    .tab-header {
      display: flex;
      border-bottom: 1px solid #ccc;
    }
    .tab-button {
      padding: 10px 20px;
      border: none;
      background: none;
      cursor: pointer;
    }
    .tab-button.active {
      border-bottom: 2px solid #007bff;
    }
    .tab-content {
      padding: 20px;
    }
  `;

  override render() {
    return html`
      <div class="tab-header">
        ${this.tabs.map(
          (tab, index) => html`
            <button
              class="tab-button ${index === this.activeTab ? "active" : ""}"
              @click=${() => this.setActiveTab(index)}
            >
              ${tab.label}
            </button>
          `
        )}
      </div>
      <div class="tab-content">${this.tabs[this.activeTab]?.content}</div>
    `;
  }

  setActiveTab(index: number) {
    this.activeTab = index;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.tabs = Array.from(this.children).map((child, index) => ({
      label: child.getAttribute("label") || `Tab ${index + 1}`,
      content: child as HTMLElement
    }));
  }
}
