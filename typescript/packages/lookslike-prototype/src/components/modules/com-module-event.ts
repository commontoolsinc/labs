import { LitElement, html, css } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { RecipeNode } from "../../data.js";

const styles = css`
  .history {
    max-height: 200px;
    overflow-y: auto;
  }

  .history ol {
    padding: 0;
    display: flex;
    flex-direction: column-reverse;
  }

  .history li {
    padding: 0.5rem;
    border-bottom: 1px solid #ccc;
  }
`;

@customElement("com-module-event")
export class ComModuleEvent extends LitElement {
  static override styles = [styles];

  @property() node: RecipeNode | null = null;
  @property() value: any = null;
  @state() history: any[] = [];

  override firstUpdated() {
    this.history = [];
    if (this.value) {
      this.history.push(this.value);
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (
      changedProperties.has("value") &&
      this.value &&
      !this.history.includes(this.value)
    ) {
      this.history.push(this.value);
    }
  }

  override render() {
    if (!this.node || !this.value) {
      return html`<pre>loading...</pre>`;
    }

    const trigger = () => {
      this.dispatchEvent(new CustomEvent("run"));
    };

    return html`
      <button @click=${trigger}>!</button>
      <div class="history">
        <ol>
          ${this.history.map(
            (ev) => html`<li><code>${JSON.stringify(ev)}</code></li>`
          )}
        </ol>
      </div>
    `;
  }
}
