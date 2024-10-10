import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";
import { createRect, Rect, positionMenu } from "../shared/position.js";
import { toggleInvisible } from "../shared/dom.js";
import { Completion } from "./editor/suggestions.js";
import { classMap } from "lit/directives/class-map.js";
import { wrapExclusive } from "../shared/number.js";

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
  open: boolean = false;

  @property({ type: Number })
  selected: number = 0;

  @property({ attribute: false })
  completions: Array<Completion> = [];

  override render() {
    const renderCompletion = (completion: Completion, index: number) => {
      const classes = classMap({
        completion: true,
        "completion--active":
          wrapExclusive(this.completions.length, this.selected) === index,
      });
      return html`
        <li class="${classes}">
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
    if (changedProperties.has("open")) {
      toggleInvisible(this, !this.open);
    }
  }
}
