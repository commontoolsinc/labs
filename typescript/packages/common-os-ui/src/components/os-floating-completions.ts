import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";
import { createRect, Rect, positionMenu } from "../shared/position.js";
import { toggleInvisible } from "../shared/dom.js";
import * as completion from "./editor/completion.js";
import { classMap } from "lit/directives/class-map.js";
import { clamp } from "../shared/number.js";

/** Completion clicked */
export class ClickCompletion extends Event {
  detail: completion.Model;

  constructor(completion: completion.Model) {
    super("click-completion", {
      bubbles: true,
      composed: true,
    });
    this.detail = completion;
  }
}

@customElement("os-floating-completions")
export class OsFloatingCompletions extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --width: calc(var(--u) * 80);
        display: block;
        left: 0;
        top: 0;
        position: absolute;
        width: var(--width);
        transition: opacity var(--dur-md) var(--ease-out-expo);
      }

      .completions {
        background-color: var(--bg);
        border-radius: var(--radius);
        box-shadow: var(--shadow-menu);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: calc(var(--u) * 2) 0;
      }

      .completion {
        cursor: pointer;
        display: flex;
        flex-direction: row;
        height: var(--min-touch-size);
        align-items: center;
        padding: var(--u) var(--pad);

        &.completion--active {
          background-color: var(--bg-scrim);
        }

        .completion--text {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }
    `,
  ];

  @property({ attribute: false })
  anchor: Rect = createRect(0, 0, 0, 0);

  @property({ attribute: false })
  show: boolean = false;

  @property({ type: Number })
  selected: number = 0;

  @property({ attribute: false })
  completions: Array<completion.Model> = [];

  override render() {
    const renderCompletion = (completion: completion.Model, index: number) => {
      const classes = classMap({
        completion: true,
        "completion--active":
          clamp(this.selected, 0, this.completions.length - 1) === index,
      });

      const onclick = (_event: MouseEvent) => {
        this.dispatchEvent(new ClickCompletion(completion));
      };

      return html`
        <li class="${classes}" @click=${onclick}>
          <div class="completion--text">${completion.text}</div>
        </li>
      `;
    };

    return html`
      <menu class="completions">${this.completions.map(renderCompletion)}</menu>
    `;
  }

  protected override updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("anchor")) {
      positionMenu(this, this.anchor);
    }
    if (changedProperties.has("show")) {
      toggleInvisible(this, !this.show);
    }
  }
}
