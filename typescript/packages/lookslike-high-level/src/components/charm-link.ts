import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { NAME } from "../data.js";
import { Cell, isReactive } from "@commontools/common-runner";

export const charmLink = render.view("common-charm-link", {
  charm: { type: "object" },
  name: { type: "string" },
});

@customElement("common-charm-link")
export class CommonCharmLink extends LitElement {
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
  charm: Cell<any> | undefined = undefined;

  @property({ type: String })
  name: string | undefined = undefined;

  private nameEffect: (() => void) | undefined;
  private nameFromCharm: string | undefined;

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
    if (changedProperties.has("charm")) {
      this.maybeListenToName(true);
    }
  }

  private maybeListenToName(skipUpdate = false) {
    if (!this.charm) return;

    // Unsubscribe from previous listener
    this.nameEffect?.();
    this.nameEffect = undefined;

    let { [NAME]: name } = this.charm.get();

    if (isReactive(name)) {
      this.nameEffect = name.sink((name: string) => {
        this.nameFromCharm = name;
        if (!skipUpdate) this.requestUpdate();
        skipUpdate = false;
      });
    } else {
      this.nameFromCharm = name;
    }
  }

  handleClick(e: Event) {
    e.preventDefault();
    this.dispatchEvent(
      new CustomEvent("open-charm", {
        detail: { charmId: this.charm!.entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    if (this.charm === undefined) return html``;

    const name = this.name ?? this.nameFromCharm ?? "(unknown)";
    return html`
      <a href="#${this.charm.entityId}" @click="${this.handleClick}"
        >💎 ${name}</a
      >
    `;
  }
}
