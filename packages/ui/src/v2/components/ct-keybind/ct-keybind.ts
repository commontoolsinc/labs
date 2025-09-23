import { html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTKeybind - Declarative keyboard shortcut listener
 *
 * @element ct-keybind
 *
 * @attr {string} name - Optional name for the binding
 * @attr {string} code - KeyboardEvent.code (e.g. "KeyO", "ArrowUp")
 * @attr {string} key - KeyboardEvent.key (fallback when code not set)
 * @attr {boolean} alt - Require Alt/Option
 * @attr {boolean} ctrl - Require Control
 * @attr {boolean} meta - Require Meta/Cmd
 * @attr {boolean} shift - Require Shift
 * @attr {boolean} ignoreEditable - Ignore when focus is in inputs
 * @attr {boolean} preventDefault - Call preventDefault() on match
 * @attr {boolean} stopPropagation - Call stopPropagation() on match
 * @attr {boolean} allowRepeat - Allow AutoRepeat (default: false)
 *
 * @fires ct-keybind - Fired when the binding matches. Detail includes:
 *   { name?, event, code, key, alt, ctrl, meta, shift }
 *
 * @example
 * <ct-keybind name="quick-jump" meta key="o"></ct-keybind>
 * <ct-keybind name="close" alt key="w"></ct-keybind>
 */
export class CTKeybind extends BaseElement {
  static override properties = {
    name: { type: String },
    code: { type: String },
    key: { type: String },
    alt: { type: Boolean, reflect: true },
    ctrl: { type: Boolean, reflect: true },
    meta: { type: Boolean, reflect: true },
    shift: { type: Boolean, reflect: true },
    ignoreEditable: { type: Boolean, attribute: "ignore-editable" },
    preventDefault: { type: Boolean, attribute: "prevent-default" },
    stopPropagation: { type: Boolean, attribute: "stop-propagation" },
    allowRepeat: { type: Boolean, attribute: "allow-repeat" },
  } as const;

  declare name?: string;
  declare code?: string;
  declare key?: string;
  declare alt: boolean;
  declare ctrl: boolean;
  declare meta: boolean;
  declare shift: boolean;
  declare ignoreEditable: boolean;
  declare preventDefault: boolean;
  declare stopPropagation: boolean;
  declare allowRepeat: boolean;

  // Track modifier state for layouts that emit separate key events
  #altDown = false;
  #ctrlDown = false;
  #metaDown = false;
  #shiftDown = false;

  constructor() {
    super();
    this.alt = false;
    this.ctrl = false;
    this.meta = false;
    this.shift = false;
    this.ignoreEditable = true;
    this.preventDefault = false;
    this.stopPropagation = false;
    this.allowRepeat = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.#onKeyDown, true);
    document.addEventListener("keyup", this.#onKeyUp, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("keydown", this.#onKeyDown, true);
    document.removeEventListener("keyup", this.#onKeyUp, true);
    super.disconnectedCallback();
  }

  override render() {
    // Non-visual helper component
    return html`

    `;
  }

  #onKeyUp = (e: KeyboardEvent) => {
    this.#updateModifiers(e, false);
  };

  #onKeyDown = (e: KeyboardEvent) => {
    this.#updateModifiers(e, true);

    if (!this.#matchesContext(e)) return;

    const matched = this.#matchesKey(e) && this.#matchesModifiers();
    if (!matched) return;

    if (!this.allowRepeat && e.repeat) return;

    if (this.preventDefault) e.preventDefault();
    if (this.stopPropagation) e.stopPropagation();

    this.emit("ct-keybind", {
      name: this.name,
      event: e,
      code: e.code,
      key: e.key,
      alt: this.#altDown,
      ctrl: this.#ctrlDown,
      meta: this.#metaDown,
      shift: this.#shiftDown,
    });
  };

  #matchesContext(e: KeyboardEvent): boolean {
    if (!this.ignoreEditable) return true;
    const t = e.target as HTMLElement | null;
    const tag = (t?.tagName || "").toLowerCase();
    const editable = !!(t && (
      t.isContentEditable || tag === "input" || tag === "textarea" ||
      tag === "select"
    ));
    return !editable;
  }

  #normalizeKey(k?: string): string | undefined {
    if (!k) return undefined;
    return k.length === 1 ? k.toLowerCase() : k;
  }

  #matchesKey(e: KeyboardEvent): boolean {
    if (this.code) {
      return e.code === this.code;
    }
    const expected = this.#normalizeKey(this.key);
    if (!expected) return false;
    const actual = this.#normalizeKey(e.key);
    return actual === expected;
  }

  #matchesModifiers(): boolean {
    if (this.alt !== this.#altDown) return false;
    if (this.ctrl !== this.#ctrlDown) return false;
    if (this.meta !== this.#metaDown) return false;
    if (this.shift !== this.#shiftDown) return false;
    return true;
  }

  #updateModifiers(e: KeyboardEvent, down: boolean) {
    switch (e.key) {
      case "Alt":
        this.#altDown = down;
        break;
      case "Control":
        this.#ctrlDown = down;
        break;
      case "Meta":
        this.#metaDown = down;
        break;
      case "Shift":
        this.#shiftDown = down;
        break;
      default: {
        // Also mirror modifier flags from event state
        this.#altDown = e.altKey;
        this.#ctrlDown = e.ctrlKey;
        this.#metaDown = e.metaKey;
        this.#shiftDown = e.shiftKey;
      }
    }
  }
}

globalThis.customElements.define("ct-keybind", CTKeybind);
