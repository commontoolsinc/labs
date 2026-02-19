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

function tooltipInfo(msg: BuiltInLLMMessage): {
  role: string;
  type: string;
  preview: string;
  toolName?: string;
} {
  const role = msg.role;
  let type = "text";
  let preview = "";
  let toolName: string | undefined;

  if (typeof msg.content === "string") {
    preview = msg.content.slice(0, 100);
  } else if (Array.isArray(msg.content)) {
    const parts = msg.content as BuiltInLLMContentPart[];
    const types = parts.map((p: BuiltInLLMContentPart) => p.type);
    if (types.includes("tool-call")) {
      type = "tool-call";
      const tc = parts.find(
        (p: BuiltInLLMContentPart) => p.type === "tool-call",
      ) as BuiltInLLMToolCallPart;
      toolName = tc?.toolName;
      preview = `${tc?.toolName}(${JSON.stringify(tc?.input).slice(0, 60)})`;
    } else if (types.includes("tool-result")) {
      type = "tool-result";
      const tr = parts.find(
        (p: BuiltInLLMContentPart) => p.type === "tool-result",
      ) as BuiltInLLMToolResultPart;
      toolName = tr?.toolName;
      preview = JSON.stringify(tr?.output).slice(0, 100);
    } else if (types.includes("image")) {
      type = "image";
      preview = "[image]";
    } else {
      const textPart = parts.find(
        (p: BuiltInLLMContentPart) => p.type === "text",
      );
      if (textPart && textPart.type === "text") {
        preview = textPart.text.slice(0, 100);
      }
    }
  }

  if (preview.length >= 100) preview += "\u2026";

  return { role, type, preview, toolName };
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
      .bead {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        cursor: default;
        flex-shrink: 0;
        transition: transform 100ms ease, box-shadow 100ms ease;
      }
      .bead:hover {
        transform: scale(1.5);
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
      .spinner {
        width: 8px;
        height: 8px;
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
    `,
  ];

  static override properties = {
    messages: { attribute: false },
    pending: { type: Boolean, reflect: true },
  } as const;

  @property({ attribute: false })
  declare messages:
    | CellHandle<BuiltInLLMMessage[]>
    | BuiltInLLMMessage[]
    | undefined;

  @property({ type: Boolean, reflect: true })
  declare pending: boolean;

  #tooltip: HTMLDivElement | null = null;

  constructor() {
    super();
    this.pending = false;
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
    const info = tooltipInfo(msg);
    const tpl = html`
      <style>
      .tp {
        position: fixed;
        background: #1e293b;
        color: #f1f5f9;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 0.72rem;
        font-family: system-ui, sans-serif;
        line-height: 1.4;
        max-width: 320px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .tp-role {
        font-weight: 600;
        text-transform: uppercase;
        font-size: 0.65rem;
        opacity: 0.7;
      }
      .tp-tool {
        color: #fbbf24;
      }
      .tp-preview {
        margin-top: 2px;
      }
      </style>
      <div class="tp">
        <div class="tp-role">
          ${info.role} &middot; ${info.type}
        </div>
        ${info.toolName
          ? html`
            <div class="tp-tool">${info.toolName}</div>
          `
          : nothing}
        <div class="tp-preview">${info.preview || "(empty)"}</div>
      </div>
    `;
    render(tpl, this.#tooltip!);

    // Position above the bead
    const rect = beadEl.getBoundingClientRect();
    const panel = this.#tooltip!.querySelector(".tp") as HTMLElement;
    if (!panel) return;

    // Initial placement for measurement
    panel.style.top = `${rect.top}px`;
    panel.style.left = `${rect.left}px`;

    requestAnimationFrame(() => {
      const pr = panel.getBoundingClientRect();
      let top = rect.top - pr.height - 6;
      let left = rect.left + rect.width / 2 - pr.width / 2;
      left = Math.max(8, Math.min(left, globalThis.innerWidth - pr.width - 8));
      if (top < 8) top = rect.bottom + 6;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.left = `${Math.round(left)}px`;
    });
  }

  private _onBeadEnter = (e: MouseEvent, index: number) => {
    const msgs = this._messagesValue;
    if (!msgs?.[index]) return;
    this.#showTooltip(msgs[index], e.currentTarget as HTMLElement);
  };

  private _onBeadLeave = () => {
    this.#unmountTooltip();
  };

  private _onRefineClick = () => {
    this.emit("ct-refine", {});
  };

  override render() {
    const msgs = this._messagesValue;
    if (!msgs || msgs.length === 0) {
      return this.pending
        ? html`
          <div class="spinner"></div>
        `
        : nothing;
    }

    const beads = msgs.map((msg, i) => {
      const color = classifyMessage(msg);
      return html`
        <div
          class="bead ${color}"
          @mouseenter="${(e: MouseEvent) => this._onBeadEnter(e, i)}"
          @mouseleave="${this._onBeadLeave}"
        >
        </div>
      `;
    });

    return html`
      ${beads} ${this.pending
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
