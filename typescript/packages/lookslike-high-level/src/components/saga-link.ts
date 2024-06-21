import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { signal, Cancel } from "@commontools/common-frp";
import { Gem, ID, NAME } from "../recipe.js";

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

  @property({ type: String })
  saga: Gem | undefined = undefined;

  @property({ type: String })
  name: string | undefined = undefined;

  private nameEffect: Cancel | undefined;
  private nameFromGem: string | undefined;

  handleClick(e: Event) {
    e.preventDefault();
    this.dispatchEvent(
      new CustomEvent("open-saga", {
        detail: { saga: this.saga },
        bubbles: true,
        composed: true,
      })
    );
  }

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
      this.maybeListenToName();
    }
  }

  private maybeListenToName() {
    if (signal.isSignal(this.saga?.[NAME])) {
      console.log("listening to name", this.saga[NAME]);
      this.nameEffect = signal.effect([this.saga[NAME]], (name: string) => {
        this.nameFromGem = name;
        this.requestUpdate();
      });
    } else {
      this.nameEffect?.();
      this.nameFromGem = this.saga?.[NAME];
    }
  }

  override render() {
    console.log("rendering saga link", this.saga, this.name);
    if (!this.saga) return html``;
    const name = this.name ?? this.nameFromGem;
    console.log("rendering saga link", name, this.saga[NAME]);
    return html`
      <a href="#${this.saga[ID]}" @click="${this.handleClick}">🔮 ${name}</a>
    `;
  }
}
