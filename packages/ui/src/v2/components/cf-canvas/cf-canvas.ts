import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export class CFCanvas extends BaseElement {
  @property({ type: Number })
  accessor width = 800;
  @property({ type: Number })
  accessor height = 600;

  @property({ type: String, attribute: "aria-label" })
  accessor accessibilityLabel = "Interactive canvas";

  @state()
  private accessor keyboardCursorX = 0;

  @state()
  private accessor keyboardCursorY = 0;

  private keyboardCursorInitialized = false;

  protected override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);

    if (!this.keyboardCursorInitialized) {
      this.initializeKeyboardCursor();
    } else if (
      changedProperties.has("width") || changedProperties.has("height")
    ) {
      this.keyboardCursorX = Math.max(
        0,
        Math.min(this.width, this.keyboardCursorX),
      );
      this.keyboardCursorY = Math.max(
        0,
        Math.min(this.height, this.keyboardCursorY),
      );
    }
  }

  static override styles = css`
    :host {
      display: block;
    }

    .canvas-container {
      position: relative;
      width: var(--canvas-width, 800px);
      height: var(--canvas-height, 600px);
      border: 1px solid #ddd;
      background: #f9f9f9;
      overflow: auto;
    }

    .canvas-container:focus-visible {
      outline: 2px solid
        var(--cf-theme-color-focus-ring, var(--cf-colors-primary-500, #4979fa));
      outline-offset: 2px;
    }

    .canvas-container ::slotted(*) {
      position: absolute !important;
    }

    .keyboard-cursor {
      position: absolute;
      z-index: 1;
      width: 14px;
      height: 14px;
      border: 2px solid
        var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa));
      border-radius: 50%;
      background: color-mix(
        in srgb,
        var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 20%,
        transparent
      );
      box-shadow: 0 0 0 2px
        var(--cf-theme-color-background, rgba(255, 255, 255, 0.9));
      opacity: 0;
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: opacity 100ms ease;
    }

    .canvas-container:focus .keyboard-cursor {
      opacity: 1;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `;

  private initializeKeyboardCursor(): void {
    if (this.keyboardCursorInitialized) return;
    this.keyboardCursorX = Math.round(this.width / 2);
    this.keyboardCursorY = Math.round(this.height / 2);
    this.keyboardCursorInitialized = true;
  }

  private moveKeyboardCursor(deltaX: number, deltaY: number): void {
    this.initializeKeyboardCursor();
    this.keyboardCursorX = Math.max(
      0,
      Math.min(this.width, this.keyboardCursorX + deltaX),
    );
    this.keyboardCursorY = Math.max(
      0,
      Math.min(this.height, this.keyboardCursorY + deltaY),
    );
  }

  private handleCanvasClick(event: MouseEvent) {
    // Check if the click is on the canvas itself, not a child element
    const target = event.target as HTMLElement;
    const container = event.currentTarget as HTMLElement;

    // If clicking on a child element (not the canvas background), ignore it
    if (target !== container) {
      return;
    }

    const rect = container.getBoundingClientRect();

    // Calculate relative position within the canvas
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);

    // Emit event using BaseElement's emit method
    this.emit("cf-canvas-click", { x, y });
  }

  private handleCanvasFocus(): void {
    this.initializeKeyboardCursor();
  }

  private handleCanvasKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 1 : 10;

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        this.moveKeyboardCursor(-step, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.moveKeyboardCursor(step, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.moveKeyboardCursor(0, -step);
        break;
      case "ArrowDown":
        event.preventDefault();
        this.moveKeyboardCursor(0, step);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.initializeKeyboardCursor();
        this.emit("cf-canvas-click", {
          x: this.keyboardCursorX,
          y: this.keyboardCursorY,
        });
        break;
    }
  }

  override render() {
    return html`
      <div
        class="canvas-container"
        style="--canvas-width: ${this.width}px; --canvas-height: ${this
          .height}px"
        role="application"
        tabindex="0"
        aria-label="${this.accessibilityLabel}"
        aria-describedby="canvas-keyboard-instructions canvas-cursor-position"
        @focus="${this.handleCanvasFocus}"
        @keydown="${this.handleCanvasKeyDown}"
        @click="${this.handleCanvasClick}"
      >
        <span id="canvas-keyboard-instructions" class="visually-hidden">
          Use arrow keys to move the cursor, hold Shift for one-pixel steps, and press
          Enter or Space to activate the current point.
        </span>
        <span
          id="canvas-cursor-position"
          class="visually-hidden"
          aria-live="polite"
        >
          Cursor at ${this.keyboardCursorX}, ${this.keyboardCursorY}.
        </span>
        <slot></slot>
        <div
          class="keyboard-cursor"
          style="left: ${this.keyboardCursorX}px; top: ${this
            .keyboardCursorY}px"
          aria-hidden="true"
        >
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-canvas": CFCanvas;
  }
}
