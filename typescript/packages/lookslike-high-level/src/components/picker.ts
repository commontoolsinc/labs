import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";

interface Item {
  value: string;
  label: string;
}

@customElement("common-picker")
export default class PickerElement extends LitElement {
  @property({ type: Array }) items: Item[] = [];
  @property({ type: String, reflect: true }) value = "";
  @property({ type: String }) filter = "";
  @property({ type: Boolean }) hasFocus = false;

  static override styles = css`
    :host {
      display: block;
      position: relative;
    }

    .picker {
      position: relative;
    }

    input {
      width: 100%;
      padding: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }

    .dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 200px;
      overflow-y: auto;
      background: white;
      border: 1px solid #ccc;
      border-top: none;
      border-radius: 0 0 4px 4px;
      display: none;
      z-index: 1000;
    }

    .dropdown.show {
      display: block;
    }

    .item {
      padding: 8px;
      cursor: pointer;
    }

    .item:hover {
      background: #f5f5f5;
    }

    .selected-value {
      margin-top: 8px;
      padding: 4px;
      color: #666;
    }
  `;

  private get filteredItems() {
    const filterLower = this.filter.toLowerCase();
    return this.items.filter(
      item =>
        item.label.toLowerCase().includes(filterLower) ||
        item.value.toString().toLowerCase().includes(filterLower),
    );
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.filter = input.value;
  }

  private handleFocus() {
    this.hasFocus = true;
  }

  private handleBlur() {
    this.hasFocus = false;
  }

  private selectItem(item: Item) {
    this.value = item.value;
    this.filter = item.label;
    this.hasFocus = false;
    this.dispatchEvent(
      new CustomEvent("pick", {
        detail: item,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const showDropdown = this.hasFocus;
    const items = this.filteredItems;
    const selectedItem = this.items.find(item => item.value === this.value);

    return html`
      <div class="picker">
        <input
          type="text"
          .value=${this.filter}
          @input=${this.handleInput}
          @focus=${this.handleFocus}
          @blur=${this.handleBlur}
          placeholder="Search..."
        />
        <div class="dropdown ${showDropdown ? "show" : ""}">
          ${items.map(
            item => html`
              <div class="item" @mousedown=${this.selectItem.bind(this, item)}>
                ${item.label}
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }
}
