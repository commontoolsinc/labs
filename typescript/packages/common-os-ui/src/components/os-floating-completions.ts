import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";
import { createRect, Rect, positionMenu } from "../shared/position.js";
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
      }

      .completions {
        background-color: var(--bg);
        border-radius: var(--radius);
        box-shadow: var(--shadow-menu);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: calc(var(--u) * 2) 0;
        left: 0;
        top: 0;
        position: absolute;
        width: var(--width);
        transition: opacity var(--dur-md) var(--ease-out-expo);
      }

      .completion {
        cursor: pointer;
        display: flex;
        flex-direction: row;
        height: var(--min-touch-size);
        align-items: center;
        padding: var(--u) var(--pad);

        :is(&.completion--active, &:hover) {
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

  #renderCompletion = (completion: completion.Model, index: number) => {
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

  override render() {
    const classes = classMap({
      completions: true,
      // Hide when no completions
      invisible: !this.show || this.completions.length === 0,
    });

    return html`
      <menu id="completions" class="${classes}">
        ${this.completions.map(this.#renderCompletion)}
      </menu>
    `;
  }

  protected override updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("anchor")) {
      const menu = this.renderRoot.querySelector("#completions") as HTMLElement;
      positionMenu(menu, this.anchor);
    }
  }
}
