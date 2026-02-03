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
import { type FormContext, formContext } from "../form-context.ts";
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
        // Sync cell value changes to DOM
        this.applyValueToDom();

        // Emit change events
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

    /* ---------- Form context integration ---------- */
    @consume({ context: formContext, subscribe: false })
    private _formContext?: FormContext;

    private _buffer: unknown | unknown[] | undefined;
    private _initialValue: unknown | unknown[] | undefined;
    private _lastCellValue: unknown | unknown[] | undefined;
    private _formUnregister?: () => void;

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
      this.applyValueToDom();
      // Apply theme on first render
      applyThemeToElement(this, this.theme ?? defaultTheme);

      // Register with form after binding is complete
      this._registerWithForm();
    }

    private _registerWithForm() {
      // Only register once
      if (this._formUnregister) return;

      // Only register if we have both a form context and a cell value binding
      if (this._formContext && this.value) {
        // Don't eagerly initialize buffer - let it stay undefined
        // getValue() will fall back to cell value when buffer is undefined

        console.log(
          `ct-select[${this.name}] _registerWithForm (deferred init)`,
        );

        // Register with form
        this._formUnregister = this._formContext.registerField({
          element: this,
          name: this.name || undefined,
          // Return buffer if user has selected, otherwise return current cell value
          getValue: () => this._buffer ?? this._cellController.getValue(),
          setValue: (v) => {
            this._buffer = v as unknown | unknown[];
            this.requestUpdate();
          },
          flush: () => {
            const valueToFlush = this._buffer ??
              this._cellController.getValue();
            console.log("ct-select flush:", valueToFlush);
            this._cellController.setValue(valueToFlush);
            this._lastCellValue = valueToFlush;
          },
          reset: () => {
            // Reset buffer to undefined - will fall back to cell value
            this._buffer = undefined;
            this._initialValue = undefined;
            this._lastCellValue = undefined;
            this.requestUpdate();
          },
          validate: () => ({
            valid: this.checkValidity(),
            message: this._select?.validationMessage,
          }),
        });
      }
    }

    // Note: _syncBufferWithCell removed - with deferred init, getValue() always
    // falls back to cell value when buffer is undefined, so no sync needed

    override disconnectedCallback() {
      super.disconnectedCallback();
      // Unregister from form if registered
      this._formUnregister?.();
      this._formUnregister = undefined;
    }

    override willUpdate(changedProperties: Map<string, any>) {
      super.willUpdate(changedProperties);

      // If the value property itself changed (e.g., switched to a different cell)
      if (changedProperties.has("value")) {
        // Bind the new value (Cell or plain) to the controller
        this._cellController.bind(this.value);
      }
    }

    override updated(changed: Map<string | number | symbol, unknown>) {
      if (changed.has("items")) {
        // Rebuild key map each time items array changes
        this._buildKeyMap();
      }

      if (changed.has("value") || changed.has("items")) {
        this.applyValueToDom();
      }
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
      return html`
        <select
          ?disabled="${this.disabled}"
          ?multiple="${this.multiple}"
          ?required="${this.required}"
          size="${ifDefined(
            this.multiple && this.size ? this.size : undefined,
          )}"
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

      // If in form context, update buffer instead of cell
      if (this._formContext) {
        this._buffer = newValue;
        this.requestUpdate();
      } else {
        // Update through cell controller
        this._cellController.setValue(newValue);
      }
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
      // If in form context, use buffer instead of cell value
      if (this._formContext && this._buffer !== undefined) {
        return this._buffer;
      }
      return this._cellController.getValue();
    }

    /**
     * After any update, ensure DOM option selection state
     * matches the current value.
     */
    private applyValueToDom() {
      if (!this._select) return;

      const currentValue = this.getCurrentValue();

      if (this.multiple) {
        const values = (currentValue as unknown[] | undefined) ?? [];
        Array.from(this._select.options).forEach((opt) => {
          const item = this._keyMap.get(opt.value);
          opt.selected = item ? values.some((v) => item.value === v) : false;
        });
      } else {
        const val = currentValue;
        const matchKey = [...this._keyMap.entries()].find(
          ([, item]) => item.value === val,
        )?.[0];

        this._select.value = matchKey ?? "";
      }
    }
  }

  globalThis.customElements.define("ct-select", CTSelect);
