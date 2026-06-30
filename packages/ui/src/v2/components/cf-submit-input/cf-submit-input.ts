import { css, html, type PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-button/cf-button.ts";

/**
 * CFSubmitInput - A text field with a submit button whose click carries the
 * typed text on the event itself.
 *
 * The submit button click is a real (trusted) DOM gesture that bubbles to this
 * host. A pattern wires `onClick` on the host and reads `event.target.value`:
 * the host mirrors the field's text in its `value` property, so the submitted
 * text rides the trusted click — together with the surrounding surface's UI
 * integrity (data-ui-action / data-ui-event-integrity on the host and an
 * ancestor). Because the text travels in the event, the consuming handler needs
 * no durable draft cell, and the field clears itself in the DOM after submit —
 * deferred past the click's handling so the value is read first, and guarded so
 * a back-to-back submit's freshly typed name is never wiped. This
 * keeps a cross-space create handler stable across retries — the event payload
 * is fixed — with nothing to clobber.
 *
 * Unlike cf-message-input (which emits a `cf-send` CustomEvent — isTrusted is
 * false for those, so they cannot carry UI integrity to a worker handler), the
 * create here flows from the raw, trusted button click.
 *
 * @element cf-submit-input
 *
 * @attr {string} placeholder - Placeholder text for the field
 * @attr {string} button-text - Text for the submit button (default: "Submit")
 * @attr {string} input-id - id forwarded to the inner <input> so callers/tests
 *   can target the field directly
 * @attr {boolean} disabled - Whether the field and button are disabled
 * @attr {string} initial-value - Optional one-time seed copied into `value` on
 *   first render; the field is uncontrolled after that
 * @attr {string} value - Live field text; read on the host as
 *   event.target.value when the submit button is clicked
 */
export class CFSubmitInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .container {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--cf-submit-input-gap, var(--cf-spacing-2, 0.5rem));
        align-items: stretch;
      }

      input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        padding: var(--cf-spacing-2, 0.5rem) var(--cf-spacing-3, 0.75rem);
        border: 1px solid var(--cf-theme-color-border, #e5e5e7);
        border-radius: var(--cf-radius-md, 8px);
        background: var(--cf-theme-color-surface, #fff);
        color: var(--cf-theme-color-text, inherit);
      }

      input:focus {
        outline: 2px solid var(--cf-theme-color-accent, #0a7);
        outline-offset: -1px;
      }

      cf-button {
        white-space: nowrap;
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    inputId: { type: String, attribute: "input-id" },
    disabled: { type: Boolean, reflect: true },
    initialValue: { type: String, attribute: "initial-value" },
    value: { type: String },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare inputId: string;
  declare disabled: boolean;
  // Optional one-time seed for the field text, copied into `value` on first
  // render. The field is uncontrolled after that.
  declare initialValue: string;
  // Mirrors the field text. Read on the host as event.target.value when the
  // submit button is clicked.
  declare value: string;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Submit";
    this.inputId = "";
    this.disabled = false;
    this.initialValue = "";
    this.value = "";
  }

  private _seeded = false;

  // Set while a submit click is in flight, between the click and the deferred
  // field-clear. A second click that arrives in that window is a duplicate
  // (the field still holds the submitted text), so its propagation to the host
  // is stopped to suppress a second create. The flag is reset when the clear
  // runs, including the case where the clear is skipped because the value
  // changed, so a later submit is never blocked.
  private _submitting = false;

  // Copy `initialValue` into the editable `value` once, the first time it is
  // present. Later `initialValue` changes and the user's own typing are left
  // alone, so the field stays uncontrolled.
  override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    if (!this._seeded && this.initialValue) {
      this._seeded = true;
      this.value = this.initialValue;
    }
  }

  private get _input(): HTMLInputElement | null | undefined {
    return this.shadowRoot?.querySelector("input");
  }

  private _onInput(event: Event) {
    this.value = (event.target as HTMLInputElement).value;
  }

  // Only the submit button click should reach a host-level onClick (the create
  // gesture). Clicks on the field (to focus/edit) or the surrounding gap compose
  // out of the shadow root and would otherwise bubble to the host and fire a
  // spurious create. Let only a click whose path runs through the submit button
  // continue; stop the rest here.
  private _onContainerClick(event: Event) {
    const fromButton = event.composedPath().some(
      (node) => (node as Element)?.tagName === "CF-BUTTON",
    );
    if (!fromButton) event.stopPropagation();
  }

  private _onSubmit(event: Event) {
    // A second click arriving before the deferred clear runs is a duplicate:
    // the field still holds the submitted text, so the host would fire a second
    // create. Stop this click at the shadow boundary so it never reaches the
    // host.
    if (this._submitting) {
      event.stopPropagation();
      return;
    }
    const submitted = this.value;
    if (!submitted.trim()) return;
    this._submitting = true;
    // Clear the field only after the submit click has been handled — the
    // framework's host-level click listener reads `event.target.value` while
    // handling the click. A `setTimeout` runs after that dispatch (a microtask
    // defer proved too early in practice), so the submitted text is captured
    // first. Clear only if the field still holds the submitted text: a
    // back-to-back create may have already typed the next name, which must not
    // be wiped. The value is local component state, so this guard is synchronous
    // and race-free — and no durable cell is written, so there is nothing to
    // clobber across the cross-space commit. The in-flight flag is reset here
    // whether or not the clear runs, so a later submit is never blocked.
    setTimeout(() => {
      this._submitting = false;
      if (this.value !== submitted) return;
      this.value = "";
      const input = this._input;
      if (input) input.value = "";
    }, 0);
  }

  override render() {
    return html`
      <div class="container" @click="${this._onContainerClick}">
        <input
          id="${this.inputId}"
          type="text"
          .value="${this.value}"
          placeholder="${this.placeholder}"
          ?disabled="${this.disabled}"
          @input="${this._onInput}"
          part="input"
        />
        <cf-button
          data-cf-button
          ?disabled="${this.disabled}"
          @click="${this._onSubmit}"
          part="button"
        >
          ${this.buttonText}
        </cf-button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-submit-input": CFSubmitInput;
  }
}
