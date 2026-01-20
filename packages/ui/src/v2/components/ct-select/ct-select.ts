import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { createCellController } from "../../core/cell-controller.ts";

/**
 * CTSelect – Dropdown/select component that accepts an array of generic JS objects
 *
 * @element ct-select
 *
 * @attr {boolean} disabled   – Whether the select is disabled
 * @attr {boolean} multiple   – Enable multiple selection
 * @attr {boolean} required   – Whether the field is required
 * @attr {number}  size       – Number of visible options (native size attribute)
 * @attr {string}  name       – Name used when participating in a form
 * @attr {string}  placeholder – Placeholder text rendered as a disabled option
 *
 * @prop {Array<SelectItem | undefined>} items – Data used to generate options
 * @prop {CellHandle<unknown>|CellHandle<unknown[]>|unknown|unknown[]} value – Selected value(s) - supports both Cell and plain values
 *
 * @fires ct-change – detail: { value, oldValue, items }
 * @fires change – detail: { value, oldValue, items }
 * @fires ct-focus
 * @fires ct-blur
 *
 * @example
 * <ct-select id="countrySelect"></ct-select>
 * <script type="module">
 *   const el = document.getElementById("countrySelect");
 *   el.items = [
 *     { label: "USA", value: { code: "US" } },
 *     { label: "Germany", value: { code: "DE" } }
 *   ];
 * </script>
 */

export interface SelectItem {
  /** Text shown to the user */
  label: string;
  /** Arbitrary JS value returned when this option is selected */
  value: unknown;
  /** Disabled state for this option */
  disabled?: boolean;
  /**
   * Optional grouping key. When provided, options with
   * identical `group` values will be wrapped in an <optgroup>.
   */
  group?: string;
}

export class CTSelect extends BaseElement {
  /* ---------- Styles ---------- */
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        width: 100%;
        box-sizing: border-box;
      }

      select {
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
        appearance: none;
        -moz-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' xmlns='http://www.w3.org/2000/svg' fill='%23666666'%3E%3Cpath d='M6 8 0 0h12L6 8Z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.75rem center;
        background-size: 12px 8px;
      }

      /* Disabled */
      select:disabled {
        cursor: not-allowed;
        opacity: 0.5;
        background-color: var(--ct-theme-color-surface, #f1f5f9);
      }

      /* Focus */
      select:focus {
        outline: none;
        border-color: var(--ct-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px
          var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
        }

        /* Hover */
        select:hover:not(:disabled):not(:focus) {
          border-color: var(--ct-theme-color-border, #d1d5db);
        }

        /* Arrow removed on multi */
        :host([multiple]) select {
          background-image: none;
        }
      `,
    ];

    private _select!: HTMLSelectElement;
    /** Mapping from stringified option key -> SelectItem */
    private _keyMap = new Map<string, SelectItem>();

    /* ---------- Cell controller for value binding ---------- */
    private _cellController = createCellController<unknown | unknown[]>(this, {
      timing: { strategy: "immediate" }, // Select changes should be immediate
      onChange: (newValue, oldValue) => {
        // Emit change events (DOM sync is now handled reactively in render())
        this.emit("ct-change", {
          value: newValue,
          oldValue,
          items: this.items,
        });

        this.emit("change", {
          value: newValue,
          oldValue,
          items: this.items,
        });
      },
    });

    /* ---------- Reactive properties ---------- */
    static override properties = {
      disabled: { type: Boolean, reflect: true },
      multiple: { type: Boolean, reflect: true },
      required: { type: Boolean, reflect: true },
      size: { type: Number },
      name: { type: String },
      placeholder: { type: String },

      // Non-attribute properties
      items: { attribute: false },
      value: { attribute: false },
    };

    declare disabled: boolean;
    declare multiple: boolean;
    declare required: boolean;
    declare size: number;
    declare name: string;
    declare placeholder: string;
    declare items: Array<SelectItem | undefined> | undefined;
    declare value:
      | CellHandle<unknown>
      | CellHandle<unknown[]>
      | unknown
      | unknown[];

    constructor() {
      super();
      this.disabled = false;
      this.multiple = false;
      this.required = false;
      this.size = 0;
      this.name = "";
      this.placeholder = "";
      this.items = [];
      this.value = this.multiple ? [] : undefined;
    }

    /* ---------- Lifecycle ---------- */
    override firstUpdated() {
      this._select = this.shadowRoot!.querySelector(
        "select",
      ) as HTMLSelectElement;

      // Initialize cell controller binding
      this._cellController.bind(this.value);
      // Apply theme on first render
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }

    override willUpdate(changedProperties: Map<string, any>) {
      super.willUpdate(changedProperties);

      // Bind on first render or when value property changes
      // This ensures getValue() works during render()
      if (changedProperties.has("value") || !this._cellController.hasCell()) {
        this._cellController.bind(this.value);
      }
    }

    override updated(changed: Map<string | number | symbol, unknown>) {
      if (changed.has("theme")) {
        applyThemeToElement(this, this.theme ?? defaultTheme);
      }
    }

    // Theme consumption
    @consume({ context: themeContext, subscribe: true })
    @property({ attribute: false })
    declare theme?: CTTheme;

    /* ---------- Render ---------- */
    override render() {
      // Build key map first so _getSelectedKey() can use it
      this._buildKeyMap();

      // Compute selected key for single-select mode
      const selectedKey = this.multiple ? undefined : this._getSelectedKey();

      return html`
        <select
          ?disabled="${this.disabled}"
          ?multiple="${this.multiple}"
          ?required="${this.required}"
          size="${ifDefined(
            this.multiple && this.size ? this.size : undefined,
          )}"
          name="${ifDefined(this.name || undefined)}"
          .value="${ifDefined(selectedKey)}"
          @change="${this._onChange}"
          @focus="${() => this.emit("ct-focus")}"
          @blur="${() => this.emit("ct-blur")}"
          part="select"
        >
          ${this._renderPlaceholder()} ${this._renderOptions()}
        </select>
      `;
    }

    /**
     * Get the option key for the currently selected value (single-select mode)
     */
    private _getSelectedKey(): string {
      const currentValue = this.getCurrentValue();
      if (currentValue === undefined || currentValue === null) return "";

      // Find the matching option key
      for (const [key, item] of this._keyMap.entries()) {
        if (this.valuesEqual(item.value, currentValue)) {
          return key;
        }
      }
      return "";
    }

    private _renderPlaceholder() {
      const currentValue = this.getCurrentValue();
      const hasSelection =
        (this.multiple ? (currentValue as unknown[])?.length : currentValue) ??
          false;

      // Use placeholder if provided, otherwise use "-" (no selection)
      const placeholderText = this.placeholder || "-";

      return html`
        <option
          value=""
          disabled
          ?selected="${!hasSelection}"
          hidden="${this.multiple ? false : true}"
        >
          ${placeholderText}
        </option>
      `;
    }

    private _renderOptions() {
      if (!this.items?.length) return nothing;

      // Get current value for reactive selection (keyMap already built in render())
      const currentValue = this.getCurrentValue();

      // Group items by `group` key
      const groups = new Map<string | undefined, SelectItem[]>();
      this.items.forEach((item) => {
        if (!item) return;
        const key = item.group;
        const arr = groups.get(key) ?? [];
        arr.push(item);
        groups.set(key, arr);
      });

      const renderItem = (item: SelectItem, index: number) => {
        const optionKey = this._makeKey(item, index);
        // Compute selected state reactively in render
        const isSelected = this.multiple
          ? ((currentValue as unknown[]) ?? []).some((v) =>
            this.valuesEqual(item.value, v)
          )
          : this.valuesEqual(item.value, currentValue);

        return html`
          <option
            value="${optionKey}"
            ?disabled="${item.disabled ?? false}"
            ?selected="${isSelected}"
            data-index="${index}"
          >
            ${item.label}
          </option>
        `;
      };

      const templates: unknown[] = [];
      let runningIndex = 0;

      groups.forEach((items, group) => {
        if (group) {
          templates.push(html`
            <optgroup label="${group}">
              ${items.map((i) => renderItem(i, runningIndex++))}
            </optgroup>
          `);
        } else {
          templates.push(...items.map((i) => renderItem(i, runningIndex++)));
        }
      });

      return templates;
    }

    /* ---------- Events ---------- */
    private _onChange(e: Event) {
      const select = e.target as HTMLSelectElement;
      const _oldValue = this.getCurrentValue();
      let newValue: unknown | unknown[];

      if (this.multiple) {
        const selectedKeys = Array.from(select.selectedOptions).map(
          (o) => o.value,
        );
        newValue = selectedKeys.map((k) => this._keyMap.get(k)!.value);
      } else {
        const optKey = select.value;
        newValue = this._keyMap.get(optKey)?.value;
      }

      // Always update through cell controller
      this._cellController.setValue(newValue);
    }

    /* ---------- Public API ---------- */
    override focus() {
      this._select?.focus();
    }

    override blur() {
      this._select?.blur();
    }

    checkValidity() {
      return this._select?.checkValidity() ?? true;
    }

    reportValidity() {
      return this._select?.reportValidity() ?? true;
    }

    /* ---------- Internal helpers ---------- */
    private _makeKey(_item: SelectItem, index: number) {
      // Unique deterministic key for each option
      return `${index}`;
    }

    private _buildKeyMap() {
      this._keyMap.clear();
      this.items?.forEach((item, index) => {
        if (!item) return;
        this._keyMap.set(this._makeKey(item, index), item);
      });
    }

    /**
     * Get the current value from the cell controller
     */
    private getCurrentValue(): unknown | unknown[] {
      return this._cellController.getValue();
    }

    /**
     * Compare two values for equality, handling proxied values from reactive system.
     * Uses JSON stringification for objects, strict equality for primitives.
     */
    private valuesEqual(a: unknown, b: unknown): boolean {
      // Handle null/undefined
      if (a === b) return true;
      if (a === null || b === null) return false;
      if (a === undefined || b === undefined) return false;

      // For primitives (string, number, boolean), use strict equality
      // But also try string comparison in case one is proxied
      if (typeof a !== "object" && typeof b !== "object") {
        return a === b || String(a) === String(b);
      }

      // For objects, compare by JSON (handles proxied objects)
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return a === b;
      }
    }
  }

  globalThis.customElements.define("ct-select", CTSelect);
