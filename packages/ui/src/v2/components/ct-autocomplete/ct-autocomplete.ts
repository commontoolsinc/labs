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
import { type Cell } from "@commontools/runner";
import { createCellController } from "../../core/cell-controller.ts";

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
 * CTAutocomplete - Search input with filterable dropdown and optional value binding
 *
 * Supports both single-select and multi-select modes, with bidirectional Cell binding.
 *
 * @element ct-autocomplete
 *
 * @attr {string} placeholder - Placeholder text for the input
 * @attr {number} maxVisible - Maximum items to show in dropdown (default: 8)
 * @attr {boolean} allowCustom - Allow free-form custom values (default: false)
 * @attr {boolean} multiple - Enable multi-select mode (default: false)
 * @attr {boolean} disabled - Whether the component is disabled
 *
 * @prop {AutocompleteItem[]} items - Items to choose from
 * @prop {Cell<string>|Cell<string[]>|string|string[]} value - Selected value(s) - supports Cell binding
 *
 * @fires ct-change - Fired when value changes: { value, oldValue }
 * @fires ct-select - Fired when an item is selected: { value, label, group?, isCustom }
 * @fires ct-open - Fired when dropdown opens
 * @fires ct-close - Fired when dropdown closes
 *
 * @example Single-select with $value binding
 * const selected = cell<string | undefined>(undefined);
 * <ct-autocomplete
 *   items={relationshipTypes}
 *   $value={selected}
 *   placeholder="Search..."
 * />
 *
 * @example Multi-select with $value binding
 * const selected = cell<string[]>([]);
 * <ct-autocomplete
 *   items={relationshipTypes}
 *   $value={selected}
 *   multiple={true}
 *   placeholder="Search to add..."
 * />
 *
 * @example Event-only API (no value binding)
 * <ct-autocomplete
 *   items={items}
 *   onct-select={(e) => console.log('Selected:', e.detail)}
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

      /* Already selected items (shown at bottom in multi-select) */
      .option.already-selected {
        cursor: pointer;
        opacity: 0.7;
        background-color: var(--ct-theme-color-surface, #f1f5f9);
      }

      .option.already-selected:hover {
        background-color: #fef2f2;
      }

      .option.already-selected.highlighted {
        background-color: #fecaca;
        color: #991b1b;
      }

      .option.already-selected .status-label {
        font-size: 0.75rem;
        font-style: italic;
        color: var(--ct-theme-color-text-muted, #6b7280);
        margin-left: 0.5rem;
      }

      /* Show "Already added" by default, "Remove" when hovered/highlighted */
      .option.already-selected .already-added-text {
        display: inline;
      }
      .option.already-selected .remove-text {
        display: none;
      }

      .option.already-selected:hover .already-added-text,
      .option.already-selected.highlighted .already-added-text {
        display: none;
      }
      .option.already-selected:hover .remove-text,
      .option.already-selected.highlighted .remove-text {
        display: inline;
        color: #dc2626;
      }
      .option.already-selected.highlighted .remove-text {
        color: #991b1b;
      }

      .selected-separator {
        border-top: 1px solid var(--ct-theme-color-border, #e5e7eb);
        margin-top: 0.25rem;
        padding-top: 0.25rem;
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
    value: { attribute: false },
    placeholder: { type: String },
    maxVisible: { type: Number },
    allowCustom: { type: Boolean },
    multiple: { type: Boolean },
    disabled: { type: Boolean },
  };

  // Public properties
  declare items: AutocompleteItem[];
  declare value: Cell<string> | Cell<string[]> | string | string[] | undefined;
  declare placeholder: string;
  declare maxVisible: number;
  declare allowCustom: boolean;
  declare multiple: boolean;
  declare disabled: boolean;

  // Cell controller for value binding
  private _cellController = createCellController<string | string[]>(this, {
    timing: { strategy: "immediate" },
    onChange: (newValue, oldValue) => {
      this.requestUpdate();
      this.emit("ct-change", { value: newValue, oldValue });
    },
  });

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
    this.value = undefined;
    this.placeholder = "";
    this.maxVisible = 8;
    this.allowCustom = false;
    this.multiple = false;
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

    // Initialize cell controller binding
    this._cellController.bind(this.value as Cell<string | string[]> | string | string[]);

    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this._cellController.bind(this.value as Cell<string | string[]> | string | string[]);
    }
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

  // Helper to get current value from cell controller
  private _getCurrentValue(): string | readonly string[] | undefined {
    return this._cellController.getValue();
  }

  // Helper to get display label for a value
  private _getLabelForValue(value: string): string {
    const item = (this.items || []).find(i => i.value === value);
    return item?.label || value;
  }

  // Get the display value for the input in single-select mode
  private get _displayValue(): string {
    // If in multi-select mode, always show the query (user is always searching)
    if (this.multiple) {
      return this._query;
    }

    // In single-select mode:
    // - If user is typing (has query), show the query
    // - Otherwise, show the selected value's label
    if (this._query) {
      return this._query;
    }

    const currentValue = this._getCurrentValue() as string | undefined;
    if (currentValue) {
      return this._getLabelForValue(currentValue);
    }

    return "";
  }

  // Helper to check if an item matches the search query
  private _itemMatchesQuery(item: AutocompleteItem, query: string): boolean {
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
  }

  // Get the set of already-selected values (for multi-select)
  private get _selectedValues(): Set<string> {
    if (!this.multiple) return new Set();
    const selected = (this._getCurrentValue() as string[] | undefined) || [];
    return new Set(selected);
  }

  // Computed: filtered items based on query (selectable items only)
  private get _filteredItems(): AutocompleteItem[] {
    const items = this.items || [];
    const selectedValues = this._selectedValues;

    // Filter out already-selected items (they'll be shown separately)
    const selectableItems = this.multiple
      ? items.filter(item => !selectedValues.has(item.value))
      : items;

    // Apply search filter
    if (!this._query.trim()) {
      return selectableItems;
    }

    const query = this._query.toLowerCase();
    return selectableItems.filter(item => this._itemMatchesQuery(item, query));
  }

  // Computed: already-selected items that match the query (for multi-select)
  private get _alreadySelectedItems(): AutocompleteItem[] {
    if (!this.multiple) return [];

    const items = this.items || [];
    const selectedValues = this._selectedValues;

    // Get selected items
    const selectedItems = items.filter(item => selectedValues.has(item.value));

    // Apply search filter if there's a query
    if (!this._query.trim()) {
      return selectedItems;
    }

    const query = this._query.toLowerCase();
    return selectedItems.filter(item => this._itemMatchesQuery(item, query));
  }

  // Computed: should show custom value option
  private get _showCustomOption(): boolean {
    if (!this.allowCustom || !this._query.trim()) {
      return false;
    }

    const queryLower = this._query.toLowerCase();
    const queryTrimmed = this._query.trim();

    // Don't show if query exactly matches an existing item
    const matchesExistingItem = (this.items || []).some(
      (item) =>
        item.value.toLowerCase() === queryLower ||
        (item.label || "").toLowerCase() === queryLower
    );

    if (matchesExistingItem) {
      return false;
    }

    // In multi mode, don't show if already selected
    if (this.multiple) {
      const selected = (this._getCurrentValue() as string[] | undefined) || [];
      if (selected.includes(queryTrimmed)) {
        return false;
      }
    }

    return true;
  }

  // Computed: total selectable items (filtered + custom if applicable)
  private get _totalSelectableItems(): number {
    return this._filteredItems.length +
           (this._showCustomOption ? 1 : 0) +
           this._alreadySelectedItems.length;
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
          .value="${this._displayValue}"
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
    const alreadySelected = this._alreadySelectedItems;

    // Show empty state only if no selectable items, no custom option, AND no already-selected items
    if (filtered.length === 0 && !this._showCustomOption && alreadySelected.length === 0) {
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

    // Add already-selected items after filtered items (multi-select only)
    // Order: filtered items → already-selected items → custom option
    const alreadySelectedStartIndex = filtered.length;
    if (alreadySelected.length > 0) {
      // Add separator if there are selectable items above
      const needsSeparator = filtered.length > 0;

      alreadySelected.forEach((item, index) => {
        const globalIndex = alreadySelectedStartIndex + index;
        const optionClasses = {
          option: true,
          "already-selected": true,
          "selected-separator": needsSeparator && index === 0,
          highlighted: globalIndex === this._highlightedIndex,
        };

        options.push(html`
          <div
            id="option-${globalIndex}"
            class="${classMap(optionClasses)}"
            role="option"
            aria-selected="${globalIndex === this._highlightedIndex}"
            @click="${() => this._removeItem(item)}"
            @mouseenter="${() => this._setHighlight(globalIndex)}"
          >
            <span class="option-label">${item.label || item.value}</span>
            <span class="status-label">
              <span class="already-added-text">Already added</span>
              <span class="remove-text">Remove</span>
            </span>
          </div>
        `);
      });
    }

    // Add custom value option at the very end
    if (this._showCustomOption) {
      const customIndex = filtered.length + alreadySelected.length;
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
    // In single-select mode with a selected value, select all text so user can easily replace
    if (!this.multiple && this._displayValue && this._input) {
      // Copy the selected label to query so user can modify it
      this._query = this._displayValue;
      // Select all text after render
      requestAnimationFrame(() => {
        this._input?.select();
      });
    }

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

      case "Backspace":
        // In single-select mode, if input is empty (showing selected label),
        // clear the selection
        if (!this.multiple && !this._query) {
          const currentValue = this._getCurrentValue();
          if (currentValue) {
            e.preventDefault();
            this._cellController.setValue("");
            this._query = "";
          }
        }
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
    // Always emit ct-select for side effects
    this.emit("ct-select", {
      value: item.value,
      label: item.label || item.value,
      group: item.group,
      isCustom: false,
    });

    // Update value through cell controller
    if (this.multiple) {
      // Add to array
      const current = (this._getCurrentValue() as readonly string[] | undefined) || [];
      if (!current.includes(item.value)) {
        this._cellController.setValue([...current, item.value]);
      }
    } else {
      // Replace single value
      this._cellController.setValue(item.value);
    }

    // Clear query for multi, keep empty for single (user can see there's no selection displayed)
    this._query = "";
    this._close();
  }

  private _selectCustomValue() {
    if (!this._query.trim()) return;

    const customValue = this._query.trim();

    // Always emit ct-select for side effects
    this.emit("ct-select", {
      value: customValue,
      label: customValue,
      isCustom: true,
    });

    // Update value through cell controller
    if (this.multiple) {
      // Add to array
      const current = (this._getCurrentValue() as readonly string[] | undefined) || [];
      if (!current.includes(customValue)) {
        this._cellController.setValue([...current, customValue]);
      }
    } else {
      // Replace single value
      this._cellController.setValue(customValue);
    }

    this._query = "";
    this._close();
  }

  private _selectHighlighted() {
    const filtered = this._filteredItems;
    const alreadySelected = this._alreadySelectedItems;
    // Order: filtered items → already-selected items → custom option
    const alreadySelectedStartIndex = filtered.length;
    const customOptionIndex = filtered.length + alreadySelected.length;

    if (this._highlightedIndex < filtered.length) {
      // Regular selectable item
      this._selectItem(filtered[this._highlightedIndex]);
    } else if (this._highlightedIndex >= alreadySelectedStartIndex &&
               this._highlightedIndex < customOptionIndex) {
      // Already-selected item - remove it
      const alreadySelectedIndex = this._highlightedIndex - alreadySelectedStartIndex;
      this._removeItem(alreadySelected[alreadySelectedIndex]);
    } else if (this._showCustomOption && this._highlightedIndex === customOptionIndex) {
      // Custom value option (at the end)
      this._selectCustomValue();
    }
  }

  // Remove an item from the selected values (multi-select only)
  private _removeItem(item: AutocompleteItem) {
    if (!this.multiple) return;

    const current = (this._getCurrentValue() as readonly string[] | undefined) || [];
    const newValue = current.filter(v => v !== item.value);
    this._cellController.setValue(newValue);

    // Don't close - user might want to remove more or add new ones
    this._query = "";
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
    // Clear query so display reverts to selected value (in single mode)
    // or empty (in multi mode)
    this._query = "";
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
