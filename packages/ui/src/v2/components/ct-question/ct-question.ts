import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTQuestion - Component for asking single questions and collecting answers
 *
 * @element ct-question
 *
 * @attr {string} question - The question text to display
 * @attr {string[]} options - Optional multiple choice options (JSON array)
 *
 * @fires ct-answer - Fired when user submits an answer, detail: { answer: string }
 *
 * @example
 * <ct-question
 *   question="What's your preferred cooking style?"
 *   options='["Quick & easy", "Elaborate meals", "Healthy focus"]'
 * ></ct-question>
 */
export class CTQuestion extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .question-card {
        background: var(--ct-color-bg, white);
        border: 1px solid var(--ct-color-border, #e5e5e7);
        border-radius: 12px;
        padding: 16px;
      }

      .question-text {
        font-size: 15px;
        font-weight: 500;
        color: var(--ct-color-text, #111827);
        margin: 0 0 12px 0;
      }

      .options {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }

      .option {
        padding: 8px 16px;
        background: var(--ct-color-bg-secondary, #f3f4f6);
        border: 2px solid transparent;
        border-radius: 20px;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .option:hover {
        background: var(--ct-color-bg-tertiary, #e5e7eb);
      }

      .option.selected {
        background: var(--ct-color-primary-surface, #eff6ff);
        border-color: var(--ct-color-primary, #3b82f6);
        color: var(--ct-color-primary, #3b82f6);
      }

      .text-input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--ct-color-border, #e5e5e7);
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        box-sizing: border-box;
      }

      .text-input:focus {
        outline: none;
        border-color: var(--ct-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      }

      .submit-btn {
        padding: 8px 20px;
        background: var(--ct-color-primary, #3b82f6);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .submit-btn:hover {
        background: var(--ct-color-primary-hover, #2563eb);
      }

      .submit-btn:disabled {
        background: var(--ct-color-gray-300, #d1d5db);
        cursor: not-allowed;
      }

      .answered {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px;
        background: var(--ct-color-success-surface, #f0fdf4);
        border: 1px solid var(--ct-color-success, #22c55e);
        border-radius: 8px;
      }

      .answered-badge {
        padding: 4px 8px;
        background: var(--ct-color-success, #22c55e);
        color: white;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
      }

      .answered-text {
        font-size: 14px;
        color: var(--ct-color-text, #111827);
      }
    `,
  ];

  @property({ type: String })
  question = "";

  @property({ type: Array })
  options: string[] = [];

  @state()
  private _selectedOption: string | null = null;

  @state()
  private _customAnswer = "";

  @state()
  private _isSubmitted = false;

  @state()
  private _answer = "";

  private _handleOptionClick(option: string): void {
    this._selectedOption = option;
    this._customAnswer = "";
  }

  private _handleInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this._customAnswer = input.value;
    this._selectedOption = null;
  }

  private _handleSubmit(): void {
    const answer = this._selectedOption || this._customAnswer;
    if (!answer) return;

    this._answer = answer;
    this._isSubmitted = true;
    this.emit("ct-answer", { answer });
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && this._customAnswer) {
      this._handleSubmit();
    }
  }

  override render() {
    if (this._isSubmitted) {
      return html`
        <div class="answered">
          <span class="answered-badge">Answered</span>
          <span class="answered-text">${this._answer}</span>
        </div>
      `;
    }

    const hasAnswer = this._selectedOption || this._customAnswer;

    return html`
      <div class="question-card">
        <p class="question-text">${this.question}</p>
        ${this.options.length > 0
          ? this._renderOptions()
          : this._renderTextInput()}
        <button
          class="submit-btn"
          ?disabled="${!hasAnswer}"
          @click="${this._handleSubmit}"
        >
          Submit
        </button>
      </div>
    `;
  }

  private _renderOptions() {
    return html`
      <div class="options">
        ${this.options.map(
          (opt) =>
            html`
              <button
                class="option ${this._selectedOption === opt ? "selected" : ""}"
                @click="${() => this._handleOptionClick(opt)}"
              >
                ${opt}
              </button>
            `,
        )}
      </div>
    `;
  }

  private _renderTextInput() {
    return html`
      <input
        type="text"
        class="text-input"
        placeholder="Type your answer..."
        .value="${this._customAnswer}"
        @input="${this._handleInputChange}"
        @keydown="${this._handleKeyDown}"
      />
    `;
  }
}

customElements.define("ct-question", CTQuestion);
