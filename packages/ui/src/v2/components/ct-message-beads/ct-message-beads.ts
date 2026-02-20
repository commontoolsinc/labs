import { css, html, nothing, render } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle, type JSONSchema } from "@commontools/runtime-client";
import { createCellController } from "../../core/cell-controller.ts";
import type {
  BuiltInLLMContentPart,
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commontools/api";

const MessagesSchema = {
  type: "array",
  items: { type: "object" },
} as const satisfies JSONSchema;

type BeadColor = "blue" | "green" | "amber" | "purple" | "gray";

function classifyMessage(msg: BuiltInLLMMessage): BeadColor {
  const { role, content } = msg;
  if (role === "system") return "gray";
  if (role === "tool") return "purple";
  if (role === "user") return "blue";
  // assistant
  if (Array.isArray(content)) {
    if (content.some((p: BuiltInLLMContentPart) => p.type === "tool-call")) {
      return "amber";
    }
  }
  return "green";
}

/** Single-line summary for a message, e.g. "user: What's the weather?" or "→ bash(ls -la…)" */
function beadLabel(msg: BuiltInLLMMessage): string {
  const clip = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + "\u2026" : s;

  if (typeof msg.content === "string") {
    return `${msg.role}: ${clip(msg.content, 50)}`;
  }

  if (!Array.isArray(msg.content)) return msg.role;

  const parts = msg.content as BuiltInLLMContentPart[];

  const tc = parts.find(
    (p: BuiltInLLMContentPart) => p.type === "tool-call",
  ) as BuiltInLLMToolCallPart | undefined;
  if (tc) return `\u2192 ${tc.toolName}`;

  const tr = parts.find(
    (p: BuiltInLLMContentPart) => p.type === "tool-result",
  ) as BuiltInLLMToolResultPart | undefined;
  if (tr) return `\u2190 ${tr.toolName}`;

  if (parts.some((p: BuiltInLLMContentPart) => p.type === "image")) {
    return `${msg.role}: [image]`;
  }

  const text = parts.find(
    (p: BuiltInLLMContentPart) => p.type === "text",
  );
  if (text && text.type === "text") {
    return `${msg.role}: ${clip(text.text, 50)}`;
  }

  return msg.role;
}

export class CTMessageBeads extends BaseElement {
  private _cellController = createCellController<BuiltInLLMMessage[]>(this, {
    timing: { strategy: "immediate" },
    onChange: () => this.requestUpdate(),
  });

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 3px;
        align-items: center;
      }
      :host([has-messages]) {
        background: rgba(0, 0, 0, 0.05);
        border-radius: 12px;
        padding: 2px 6px;
      }
      @keyframes bead-in {
        from {
          opacity: 0;
          transform: scale(0.3) translateY(4px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
      .bead {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        cursor: pointer;
        flex-shrink: 0;
        transition: transform 100ms ease, box-shadow 100ms ease;
        animation: bead-in 250ms ease-out both;
      }
      .bead:hover {
        transform: scale(1.6);
      }
      .bead.blue {
        background: #3b82f6;
      }
      .bead.blue:hover {
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
      }
      .bead.green {
        background: #22c55e;
      }
      .bead.green:hover {
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.3);
      }
      .bead.amber {
        background: #f59e0b;
      }
      .bead.amber:hover {
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
      }
      .bead.purple {
        background: #a855f7;
      }
      .bead.purple:hover {
        box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.3);
      }
      .bead.gray {
        background: #9ca3af;
      }
      .bead.gray:hover {
        box-shadow: 0 0 0 2px rgba(156, 163, 175, 0.3);
      }
      .label {
        font-size: 10px;
        color: #9ca3af;
        margin-right: 2px;
      }
      .spinner {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        border: 1.5px solid rgba(156, 163, 175, 0.3);
        border-top-color: #9ca3af;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .refine-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 1px solid rgba(156, 163, 175, 0.4);
        background: transparent;
        cursor: pointer;
        flex-shrink: 0;
        font-size: 10px;
        line-height: 1;
        color: #9ca3af;
        padding: 0;
        transition: background 100ms ease, color 100ms ease;
      }
      .refine-btn:hover {
        background: rgba(156, 163, 175, 0.15);
        color: #6b7280;
      }
      .placeholder {
        color: var(--ct-theme-color-text-muted, #999);
        font-size: 14px;
        white-space: nowrap;
      }
      :host(:not(:empty)) .placeholder {
        display: contents;
      }
    `,
  ];

  static override properties = {
    messages: { attribute: false },
    pending: { type: Boolean, reflect: true },
    label: { type: String },
  } as const;

  @property({ attribute: false })
  declare messages:
    | CellHandle<BuiltInLLMMessage[]>
    | BuiltInLLMMessage[]
    | undefined;

  @property({ type: Boolean, reflect: true })
  declare pending: boolean;

  @property({ type: String })
  declare label: string;

  #tooltip: HTMLDivElement | null = null;

  constructor() {
    super();
    this.pending = false;
    this.label = "";
  }

  private get _messagesValue(): BuiltInLLMMessage[] | undefined {
    return (this._cellController.getValue() as BuiltInLLMMessage[]) ??
      undefined;
  }

  override firstUpdated(changedProperties: Map<string, unknown>): void {
    super.firstUpdated(changedProperties);
    if (this.messages !== undefined) {
      this._cellController.bind(this.messages, MessagesSchema);
    }
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("messages") && this.messages !== undefined) {
      this._cellController.bind(this.messages, MessagesSchema);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#unmountTooltip();
  }

  #mountTooltip(): void {
    if (this.#tooltip) return;
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.zIndex = "1001";
    el.style.pointerEvents = "none";
    el.dataset.ctMessageBeadsTooltip = "";
    document.body.appendChild(el);
    this.#tooltip = el;
  }

  #unmountTooltip(): void {
    if (this.#tooltip) {
      render(nothing, this.#tooltip);
      this.#tooltip.remove();
      this.#tooltip = null;
    }
  }

  #showTooltip(msg: BuiltInLLMMessage, beadEl: HTMLElement): void {
    this.#mountTooltip();
    const label = beadLabel(msg);
    const tpl = html`
      <style>
      .tp {
        position: fixed;
        background: #1e293b;
        color: #e2e8f0;
        padding: 2px 7px;
        border-radius: 4px;
        font: 500 11px/1.3 system-ui, sans-serif;
        white-space: nowrap;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
        pointer-events: none;
      }
      </style>
      <div class="tp">${label}</div>
    `;
    render(tpl, this.#tooltip!);

    const rect = beadEl.getBoundingClientRect();
    const panel = this.#tooltip!.querySelector(".tp") as HTMLElement;
    if (!panel) return;

    // Place offscreen for measurement, then position
    panel.style.top = "-9999px";
    panel.style.left = "-9999px";

    requestAnimationFrame(() => {
      const pr = panel.getBoundingClientRect();
      let top = rect.top - pr.height - 4;
      let left = rect.left + rect.width / 2 - pr.width / 2;
      left = Math.max(4, Math.min(left, globalThis.innerWidth - pr.width - 4));
      if (top < 4) top = rect.bottom + 4;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.left = `${Math.round(left)}px`;
    });
  }

  private _onBeadEnter = (e: MouseEvent, index: number) => {
    const msgs = this._messagesValue;
    if (!msgs?.[index]) return;
    this.#showTooltip(msgs[index], e.currentTarget as HTMLElement);
  };

  private _onBeadClick = (_e: MouseEvent, index: number) => {
    const msgs = this._messagesValue;
    if (!msgs?.[index]) return;
    // Future: show message detail on click
  };

  private _onBeadLeave = () => {
    this.#unmountTooltip();
  };

  private _onRefineClick = () => {
    this.emit("ct-refine", {});
  };

  override render() {
    const msgs = this._messagesValue;
    const hasMessages = msgs && msgs.length > 0;
    this.toggleAttribute("has-messages", !!hasMessages);

    if (!hasMessages) {
      return this.pending
        ? html`
          <div class="spinner"></div>
        `
        : html`
          <span class="placeholder"><slot></slot></span>
        `;
    }

    const beads = msgs.map((msg, i) => {
      const color = classifyMessage(msg);
      return html`
        <div
          class="bead ${color}"
          style="animation-delay: ${i * 30}ms"
          @mouseenter="${(e: MouseEvent) => this._onBeadEnter(e, i)}"
          @mouseleave="${this._onBeadLeave}"
          @click="${(e: MouseEvent) => this._onBeadClick(e, i)}"
        >
        </div>
      `;
    });

    return html`
      ${this.label
        ? html`
          <span class="label">${this.label}</span>
        `
        : nothing} ${beads} ${this.pending
        ? html`
          <div class="spinner"></div>
        `
        : html`
          <button
            class="refine-btn"
            title="Refine"
            @click="${this._onRefineClick}"
          >
            +
          </button>
        `}
    `;
  }
}

globalThis.customElements.define("ct-message-beads", CTMessageBeads);

export type { CTMessageBeads as CTMessageBeadsElement };
