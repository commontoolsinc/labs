import { LitElement, html, css } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { anchor, cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";
import { computed, effect } from "@vue/reactivity";
import { mix } from "../math.js";
import { appPlan } from "./com-app.js";

const lastHistory = computed(
  () => appPlan.history[appPlan.history.length - 1].content
);

const restingPoint = computed(() => {
  const focus = [...cursor.focus];
  if (focus.length === 0) {
    return anchor();
  }

  // average position of all elements in focus
  const sum = focus.reduce(
    (acc, { id, element }) => {
      const rect = element.getBoundingClientRect();
      return {
        x: acc.x + rect.left + rect.width / 2,
        y: acc.y + rect.top + rect.height / 2
      };
    },
    { x: 0, y: 0 }
  );

  const final = {
    x: mix(sum.x / focus.length + cursor.offset.x, anchor().x, 0.1),
    y: sum.y / focus.length + cursor.offset.y
  };

  return final;
});

@customElement("com-cursor")
export class ComCursor extends LitElement {
  private animationFrameId: number | null = null;
  private springFactor = 0.05;

  @state()
  private isAnimating = false;

  @state()
  private isInputFocused = false;

  @query("textarea")
  private textareaElement!: HTMLTextAreaElement;

  static override styles = css`
    :host {
      position: absolute;
      z-index: 9999;
      transform: translate(-50%, -50%);
    }
    .cursor-bubble {
      width: 48px;
      height: 48px;
      border-radius: 24px;
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 12px;
      color: black;
      transition: all 0.3s ease;
      overflow: hidden;
    }
    .cursor-bubble.expanded {
      width: auto;
      max-width: 400px;
      height: auto;
      border-radius: 12px;
      padding: 12px;
    }
    .cursor-bubble.idle {
      background-color: #fff;
    }
    .cursor-bubble.sketching {
      background-color: #efa3f7;
      width: auto;
      max-width: 400px;
    }
    .cursor-bubble.detailing {
      background-color: #f7a3de;
      width: auto;
      max-width: 400px;
    }
    .cursor-bubble.reflecting {
      background-color: #a3a4f7;
      width: auto;
      max-width: 400px;
    }
    .cursor-bubble.working {
      background-color: #ffe294;
      width: auto;
      max-width: 400px;
    }
    .cursor-bubble.error {
      background-color: #e74c3c;
    }

    @keyframes bounce {
      0%,
      100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.2);
      }
    }
    .bouncing {
      animation: bounce 0.5s ease;
    }

    textarea {
      width: 0px;
      min-height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: black;
      font-size: 24px;
      line-height: 24px;
      transition: all 0.3s ease;
      pointer-events: auto;
      font-family: "Palatino", "Georgia", serif;
      outline: none;
      resize: none;
      overflow: hidden;
    }
    .expanded textarea {
      width: 100%;
    }

    .message {
      min-width: 140px;
    }

    .selected {
      position: absolute;
      width: fit-content;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("keydown", this.handleKeyDown);
    this.startAnimation();

    effect(() => {
      console.log("cursor state changed", cursor.state);
      this.triggerBounceAnimation();
    });
    this.adjustTextareaHeight();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.stopAnimation();
  }

  private handleMouseMove = (e: MouseEvent) => {
    cursor.position.x = e.clientX;
    cursor.position.y = e.clientY;
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key === "k")) {
      e.preventDefault();
      this.focusInput();
    }

    if (e.key === "Escape") {
      this.blurInput();
    }

    if (e.key === "Enter" && !e.shiftKey && this.isInputFocused) {
      e.preventDefault();
      this.dispatchEvent(
        new CustomEvent("message", {
          detail: { message: cursor.userInput }
        })
      );
      this.blurInput();
      cursor.userInput = "";
      this.adjustTextareaHeight();
    }
  };

  private focusInput() {
    if (this.textareaElement) {
      this.textareaElement.focus();
    }
  }

  private blurInput() {
    if (this.textareaElement) {
      this.textareaElement.blur();
    }
  }

  private startAnimation() {
    const animate = () => {
      this.updatePosition();
      this.animationFrameId = requestAnimationFrame(animate);
    };
    this.animationFrameId = requestAnimationFrame(animate);
  }

  private stopAnimation() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private updatePosition() {
    const currentX = parseFloat(this.style.left || "0");
    const currentY = parseFloat(this.style.top || "0");

    let targetX = restingPoint.value.x;
    let targetY = restingPoint.value.y;

    if (this.isInputFocused) {
      targetX = window.innerWidth / 2;
      targetY = window.innerHeight / 2;
    }

    const dx = targetX - currentX;
    const dy = targetY - currentY;

    const newX = currentX + dx * this.springFactor;
    const newY = currentY + dy * this.springFactor;

    this.style.left = `${newX}px`;
    this.style.top = `${newY}px`;
  }

  private triggerBounceAnimation() {
    this.isAnimating = true;
    setTimeout(() => {
      this.isAnimating = false;
    }, 500);
  }

  private handleInputFocus = () => {
    this.isInputFocused = true;
    this.adjustTextareaHeight();
  };

  private handleInputBlur = () => {
    this.isInputFocused = false;
  };

  private handleInputChange = (e: Event) => {
    const textarea = e.target as HTMLTextAreaElement;
    cursor.userInput = textarea.value;
    this.adjustTextareaHeight();
  };

  private adjustTextareaHeight() {
    if (!this.textareaElement) return;

    if (this.textareaElement.value === "") {
      this.textareaElement.style.height = "auto";
      return;
    }

    if (this.textareaElement) {
      this.textareaElement.style.height = "auto";
      this.textareaElement.style.height = `${this.textareaElement.scrollHeight}px`;
    }
  }

  override render() {
    const onPlayPause = () => {
      this.dispatchEvent(new CustomEvent("toggled"));
    };

    return html`
      <div
        class="cursor-bubble ${cursor.state} ${this.isAnimating
          ? "bouncing"
          : ""} ${this.isInputFocused ? "expanded" : ""}"
      >
        ${this.isInputFocused
          ? html``
          : html`<button @click=${onPlayPause}>
              ${cursor.state === "idle" ? "Go" : "Stop"}
            </button>`}
        ${cursor.state === "idle"
          ? html` <textarea
              rows="1"
              .value=${cursor.userInput}
              @focus=${this.handleInputFocus}
              @blur=${this.handleInputBlur}
              @input=${this.handleInputChange}
            ></textarea>`
          : html`<com-loader></com-loader>
              <div class="message">
                <com-typing-preview
                  .text=${watch(lastHistory)}
                ></com-typing-preview>
              </div>`}
      </div>
    `;
  }
}
