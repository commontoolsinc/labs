import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { NAME } from "../data.js";
import { gemById, isReactive } from "@commontools/common-runner";

export const sagaLink = render.view("common-saga-link", {
  saga: { type: "object" },
  name: { type: "string" },
});

@customElement("common-saga-link")
export class CommonSagaLink extends LitElement {
  static override styles = css`
    a {
      color: #3366cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: Number })
  saga: number | undefined = undefined;

  @property({ type: String })
  name: string | undefined = undefined;

  private nameEffect: (() => void) | undefined;
  private nameFromGem: string | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this.maybeListenToName();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.nameEffect?.();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("saga")) {
      this.maybeListenToName(true);
    }
  }

  private maybeListenToName(skipUpdate = false) {
    const saga = this.saga !== undefined && gemById.get(this.saga);
    if (!saga) return;

    let name = saga.asSimpleCell().get()[NAME];

    if (isReactive(name)) {
      this.nameEffect = name.sink((name: string) => {
        this.nameFromGem = name;
        if (!skipUpdate) this.requestUpdate();
        skipUpdate = false;
      });
    } else {
      this.nameEffect?.();
      this.nameFromGem = name;
    }
  }

  handleClick(e: Event) {
    e.preventDefault();
    this.dispatchEvent(
      new CustomEvent("open-saga", {
        detail: { sagaId: this.saga },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    if (this.saga === undefined) return html``;
    const saga = gemById.get(this.saga);
    if (!saga) return html`<div>⚠️ (unknown saga)</div>`;

    const name = this.name ?? this.nameFromGem ?? "(unknown)";
    return html`
      <a href="#${this.saga}" @click="${this.handleClick}">💎 ${name}</a>
    `;
  }
}
