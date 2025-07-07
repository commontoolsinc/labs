import { css, html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

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
 * @prop {Array<SelectItem>} items – Data used to generate options
 * @prop {unknown|unknown[]} value – Selected value(s). Array when `multiple`
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
        color: var(--foreground, hsl(0, 0%, 9%));
        background-color: var(--background, hsl(0, 0%, 100%));
        border: 1px solid var(--border, hsl(0, 0%, 89%));
        border-radius: var(--radius, 0.375rem);
        transition: all var(--ct-transition-duration-fast)
          var(--ct-transition-timing-ease);
        font-family: inherit;
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
        background-color: var(--muted, hsl(0, 0%, 96%));
      }

      /* Focus */
      select:focus {
        outline: none;
        border-color: var(--ring, hsl(212, 100%, 47%));
        box-shadow: 0 0 0 3px var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
      }

      /* Hover */
      select:hover:not(:disabled):not(:focus) {
        border-color: var(--border-hover, hsl(0, 0%, 78%));
      }

      /* Arrow removed on multi */
      :host([multiple]) select {
        background-image: none;
      }
    `,
  ];

  /* ---------- Refs & helpers ---------- */
  private _select!: HTMLSelectElement;
  /** Mapping from stringified option key -> SelectItem */
  private _keyMap = new Map<string, SelectItem>();

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
  declare items: SelectItem[];
  declare value: unknown | unknown[];

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
    this.applyValueToDom();
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    if (changed.has("items")) {
      // Rebuild key map each time items array changes
      this._buildKeyMap();
    }
    if (changed.has("value") || changed.has("items")) {
      this.applyValueToDom();
    }
  }

  /* ---------- Render ---------- */
  override render() {
    return html`
      <select
        ?disabled="${this.disabled}"
        ?multiple="${this.multiple}"
        ?required="${this.required}"
        size="${ifDefined(this.multiple && this.size ? this.size : undefined)}"
        name="${ifDefined(this.name || undefined)}"
        @change="${this._onChange}"
        @focus="${() => this.emit("ct-focus")}"
        @blur="${() => this.emit("ct-blur")}"
        part="select"
      >
        ${this._renderPlaceholder()} ${this._renderOptions()}
      </select>
    `;
  }

  private _renderPlaceholder() {
    const hasSelection =
      (this.multiple ? (this.value as unknown[])?.length : this.value) ?? false;

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

    // Group items by `group` key
    const groups = new Map<string | undefined, SelectItem[]>();
    this.items.forEach((item) => {
      const key = item.group;
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    });

    const renderItem = (item: SelectItem, index: number) => {
      const optionKey = this._makeKey(item, index);
      return html`
        <option
          value="${optionKey}"
          ?disabled="${item.disabled ?? false}"
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

    // Build key map once per render
    this._buildKeyMap();

    return templates;
  }

  /* ---------- Events ---------- */
  private _onChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const oldValue = this.value;

    if (this.multiple) {
      const selectedKeys = Array.from(select.selectedOptions).map(
        (o) => o.value,
      );
      const vals = selectedKeys.map((k) => this._keyMap.get(k)!.value);
      this.value = vals;
    } else {
      const optKey = select.value;
      this.value = this._keyMap.get(optKey)?.value;
    }

    this.emit("ct-change", {
      value: this.value,
      oldValue,
      items: this.items,
    });

    // Also emit a standard "change" event for frameworks that rely on it
    this.emit("change", {
      value: this.value,
      oldValue,
      items: this.items,
    });
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
  private _makeKey(item: SelectItem, index: number) {
    // Unique deterministic key for each option
    return `${index}`;
  }

  private _buildKeyMap() {
    this._keyMap.clear();
    this.items.forEach((item, index) => {
      this._keyMap.set(this._makeKey(item, index), item);
    });
  }

  /**
   * After any update, ensure DOM option selection state
   * matches the `value` property.
   */
  private applyValueToDom() {
    if (!this._select) return;

    if (this.multiple) {
      const values = (this.value as unknown[] | undefined) ?? [];
      Array.from(this._select.options).forEach((opt) => {
        const item = this._keyMap.get(opt.value);
        opt.selected = item ? values.includes(item.value) : false;
      });
    } else {
      const val = this.value;
      const matchKey = [...this._keyMap.entries()].find(
        ([, item]) => item.value === val,
      )?.[0];

      this._select.value = matchKey ?? "";
    }
  }
}

globalThis.customElements.define("ct-select", CTSelect);
