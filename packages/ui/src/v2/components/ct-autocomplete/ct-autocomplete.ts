import { css, html, nothing, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * AutocompleteItem - Item format for ct-autocomplete
 */
export interface AutocompleteItem {
  /** Value returned when selected */
  value: string;
  /** Display text (defaults to value if not provided) */
  label?: string;
  /** Category for grouping/disambiguation */
  group?: string;
  /** Additional search terms that match this item */
  searchAliases?: string[];
}

/**
 * CTAutocomplete - Search input with filterable dropdown
 *
 * @element ct-autocomplete
 *
 * @attr {string} placeholder - Placeholder text for the input
 * @attr {number} maxVisible - Maximum items to show in dropdown (default: 8)
 * @attr {boolean} allowCustom - Allow free-form custom values (default: false)
 * @attr {boolean} disabled - Whether the component is disabled
 *
 * @prop {AutocompleteItem[]} items - Items to choose from
 *
 * @fires ct-select - Fired when an item is selected: { value, label, group?, isCustom }
 * @fires ct-open - Fired when dropdown opens
 * @fires ct-close - Fired when dropdown closes
 *
 * @example
 * <ct-autocomplete
 *   .items=${[
 *     { value: "colleague", label: "Colleague", group: "Professional" },
 *     { value: "friend", label: "Friend", group: "Personal" },
 *   ]}
 *   @ct-select=${(e) => console.log('Selected:', e.detail)}
 *   placeholder="Search..."
 * />
 */
export class CTAutocomplete extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        position: relative;
        width: 100%;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .autocomplete-container {
        position: relative;
        width: 100%;
      }

      /* Input styling - matches ct-input */
      input {
        display: block;
        width: 100%;
        padding: 0.5rem 0.75rem;
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--ct-theme-color-text, #111827);
        background-color: var(--ct-theme-color-background, #ffffff);
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        transition: all var(--ct-theme-animation-duration, 150ms)
          var(--ct-transition-timing-ease);
        font-family: var(--ct-theme-font-family, inherit);
      }

      input::placeholder {
        color: var(--ct-theme-color-text-muted, #6b7280);
      }

      input:hover:not(:disabled):not(:focus) {
        border-color: var(--ct-theme-color-border, #d1d5db);
      }

      input:focus {
        outline: none;
        border-color: var(--ct-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px
          var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
      }

      input:disabled {
        cursor: not-allowed;
        opacity: 0.5;
        background-color: var(--ct-theme-color-surface, #f1f5f9);
      }

      /* Dropdown styling - uses fixed positioning to escape overflow:hidden containers */
      .dropdown {
        position: fixed;
        background: var(--ct-theme-color-background, #ffffff);
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
        max-height: calc(var(--max-visible, 8) * 2.5rem);
        overflow-y: auto;
        z-index: 9999;
      }

      .dropdown.hidden {
        display: none;
      }

      /* Option styling */
      .option {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        transition: background-color 100ms ease;
      }

      .option:hover {
        background-color: var(--ct-theme-color-surface, #f1f5f9);
      }

      .option.highlighted {
        background-color: var(--ct-theme-color-primary, #3b82f6);
        color: white;
      }

      .option.highlighted .option-group {
        color: rgba(255, 255, 255, 0.7);
      }

      .option-label {
        font-size: 0.875rem;
      }

      .option-group {
        font-size: 0.75rem;
        color: var(--ct-theme-color-text-muted, #6b7280);
        margin-left: 0.5rem;
      }

      /* Custom value option */
      .option.custom {
        border-top: 1px solid var(--ct-theme-color-border, #e5e7eb);
        font-style: italic;
      }

      /* Empty state */
      .empty-state {
        padding: 0.75rem;
        text-align: center;
        color: var(--ct-theme-color-text-muted, #6b7280);
        font-size: 0.875rem;
      }
    `,
  ];

  static override properties = {
    items: { attribute: false },
    placeholder: { type: String },
    maxVisible: { type: Number },
    allowCustom: { type: Boolean },
    disabled: { type: Boolean },
  };

  // Public properties
  declare items: AutocompleteItem[];
  declare placeholder: string;
  declare maxVisible: number;
  declare allowCustom: boolean;
  declare disabled: boolean;

  // Internal state
  @state() private _isOpen = false;
  @state() private _query = "";
  @state() private _highlightedIndex = 0;
  @state() private _dropdownStyle = "";

  // Element references
  private _input: HTMLInputElement | null = null;
  private _dropdown: HTMLElement | null = null;

  constructor() {
    super();
    this.items = [];
    this.placeholder = "";
    this.maxVisible = 8;
    this.allowCustom = false;
    this.disabled = false;
  }

  // Theme consumption
  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  override connectedCallback() {
    super.connectedCallback();
    // Listen for clicks outside to close dropdown
    document.addEventListener("click", this._handleOutsideClick);
    // Close dropdown on scroll/resize to avoid mispositioned dropdown
    globalThis.addEventListener("scroll", this._handleScrollOrResize, true);
    globalThis.addEventListener("resize", this._handleScrollOrResize);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._handleOutsideClick);
    globalThis.removeEventListener("scroll", this._handleScrollOrResize, true);
    globalThis.removeEventListener("resize", this._handleScrollOrResize);
  }

  private _handleScrollOrResize = () => {
    if (this._isOpen) {
      this._updateDropdownPosition();
    }
  };

  override firstUpdated() {
    this._input = this.shadowRoot?.querySelector("input") || null;
    this._dropdown = this.shadowRoot?.querySelector(".dropdown") || null;
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }

    // Update dropdown position when opening
    if (changedProperties.has("_isOpen") && this._isOpen) {
      this._updateDropdownPosition();
    }
  }

  // Computed: filtered items based on query
  private get _filteredItems(): AutocompleteItem[] {
    if (!this._query.trim()) {
      return this.items;
    }

    const query = this._query.toLowerCase();

    return this.items.filter((item) => {
      const label = (item.label || item.value).toLowerCase();
      const value = item.value.toLowerCase();
      const group = (item.group || "").toLowerCase();

      // Check label, value, and group
      if (
        label.includes(query) ||
        value.includes(query) ||
        group.includes(query)
      ) {
        return true;
      }

      // Check searchAliases
      if (item.searchAliases) {
        return item.searchAliases.some((alias) =>
          alias.toLowerCase().includes(query)
        );
      }

      return false;
    });
  }

  // Computed: should show custom value option
  private get _showCustomOption(): boolean {
    if (!this.allowCustom || !this._query.trim()) {
      return false;
    }

    // Don't show if query exactly matches an existing item
    const queryLower = this._query.toLowerCase();
    return !this.items.some(
      (item) =>
        item.value.toLowerCase() === queryLower ||
        (item.label || "").toLowerCase() === queryLower
    );
  }

  // Computed: total selectable items (filtered + custom if applicable)
  private get _totalSelectableItems(): number {
    return this._filteredItems.length + (this._showCustomOption ? 1 : 0);
  }

  override render() {
    const dropdownClasses = {
      dropdown: true,
      hidden: !this._isOpen,
    };

    return html`
      <div class="autocomplete-container">
        <input
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="${this._isOpen}"
          aria-controls="dropdown"
          aria-activedescendant="${this._isOpen
            ? `option-${this._highlightedIndex}`
            : ""}"
          .value="${this._query}"
          placeholder="${this.placeholder}"
          ?disabled="${this.disabled}"
          @input="${this._handleInput}"
          @focus="${this._handleFocus}"
          @keydown="${this._handleKeyDown}"
          part="input"
        />

        <div
          id="dropdown"
          class="${classMap(dropdownClasses)}"
          role="listbox"
          style="${this._dropdownStyle}; --max-visible: ${this.maxVisible}"
        >
          ${this._renderDropdownContent()}
        </div>
      </div>
    `;
  }

  private _renderDropdownContent() {
    const filtered = this._filteredItems;

    if (filtered.length === 0 && !this._showCustomOption) {
      return html`<div class="empty-state">No matching options</div>`;
    }

    const options = filtered.map((item, index) => {
      const optionClasses = {
        option: true,
        highlighted: index === this._highlightedIndex,
      };

      return html`
        <div
          id="option-${index}"
          class="${classMap(optionClasses)}"
          role="option"
          aria-selected="${index === this._highlightedIndex}"
          @click="${() => this._selectItem(item)}"
          @mouseenter="${() => this._setHighlight(index)}"
        >
          <span class="option-label">${item.label || item.value}</span>
          ${item.group
            ? html`<span class="option-group">${item.group}</span>`
            : nothing}
        </div>
      `;
    });

    // Add custom value option if applicable
    if (this._showCustomOption) {
      const customIndex = filtered.length;
      const customClasses = {
        option: true,
        custom: true,
        highlighted: customIndex === this._highlightedIndex,
      };

      options.push(html`
        <div
          id="option-${customIndex}"
          class="${classMap(customClasses)}"
          role="option"
          aria-selected="${customIndex === this._highlightedIndex}"
          @click="${this._selectCustomValue}"
          @mouseenter="${() => this._setHighlight(customIndex)}"
        >
          <span class="option-label">Add "${this._query}"</span>
        </div>
      `);
    }

    return options;
  }

  // Event handlers
  private _handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this._query = input.value;
    this._highlightedIndex = 0;

    if (!this._isOpen && this._query) {
      this._open();
    }
  }

  private _handleFocus() {
    if (!this._isOpen) {
      this._open();
    }
  }

  private _handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this._isOpen) {
          this._open();
        } else {
          this._moveHighlight(1);
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        if (this._isOpen) {
          this._moveHighlight(-1);
        }
        break;

      case "Enter":
        e.preventDefault();
        if (this._isOpen) {
          this._selectHighlighted();
        }
        break;

      case "Escape":
        e.preventDefault();
        this._close();
        break;

      case "Tab":
        this._close();
        break;
    }
  }

  private _handleOutsideClick = (e: MouseEvent) => {
    if (!this._isOpen) return;

    const path = e.composedPath();
    if (!path.includes(this)) {
      this._close();
    }
  };

  // Selection methods
  private _selectItem(item: AutocompleteItem) {
    this.emit("ct-select", {
      value: item.value,
      label: item.label || item.value,
      group: item.group,
      isCustom: false,
    });

    this._query = "";
    this._close();
  }

  private _selectCustomValue() {
    if (!this._query.trim()) return;

    this.emit("ct-select", {
      value: this._query.trim(),
      label: this._query.trim(),
      isCustom: true,
    });

    this._query = "";
    this._close();
  }

  private _selectHighlighted() {
    const filtered = this._filteredItems;

    if (this._highlightedIndex < filtered.length) {
      this._selectItem(filtered[this._highlightedIndex]);
    } else if (this._showCustomOption) {
      this._selectCustomValue();
    }
  }

  // Highlight navigation
  private _setHighlight(index: number) {
    this._highlightedIndex = index;
  }

  private _moveHighlight(delta: number) {
    const total = this._totalSelectableItems;
    if (total === 0) return;

    this._highlightedIndex =
      (this._highlightedIndex + delta + total) % total;

    // Scroll the highlighted option into view
    this._scrollHighlightedIntoView();
  }

  private _scrollHighlightedIntoView() {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      const option = this.shadowRoot?.querySelector(
        `#option-${this._highlightedIndex}`
      );
      if (option) {
        option.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  // Open/close methods
  private _open() {
    if (this.disabled) return;

    this._isOpen = true;
    this._highlightedIndex = 0;
    this.emit("ct-open", {});
  }

  private _close() {
    this._isOpen = false;
    this.emit("ct-close", {});
  }

  // Dropdown positioning
  private _updateDropdownPosition() {
    if (!this._input) return;

    const inputRect = this._input.getBoundingClientRect();
    const viewportHeight = globalThis.innerHeight;
    const dropdownHeight = Math.min(
      this._totalSelectableItems * 40,
      this.maxVisible * 40
    );

    const spaceBelow = viewportHeight - inputRect.bottom;
    const spaceAbove = inputRect.top;

    // Calculate fixed position coordinates
    const left = inputRect.left;
    const width = inputRect.width;

    // Position above if not enough space below but enough above
    let top: number;
    if (spaceBelow < dropdownHeight && spaceAbove > dropdownHeight) {
      // Position above the input
      top = inputRect.top - dropdownHeight - 4;
    } else {
      // Position below the input
      top = inputRect.bottom + 4;
    }

    this._dropdownStyle = `top: ${top}px; left: ${left}px; width: ${width}px`;
  }

  // Public API
  override focus(): void {
    this._input?.focus();
  }

  override blur(): void {
    this._input?.blur();
    this._close();
  }

  /** Clear the current query */
  clear(): void {
    this._query = "";
    this._close();
  }
}

globalThis.customElements.define("ct-autocomplete", CTAutocomplete);
