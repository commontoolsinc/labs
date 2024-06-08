import { LitElement } from "lit";
import { html } from "lit-html";
import { signal, config } from "@commontools/common-frp";
import { watch } from "../index.js";
import { customElement } from "lit/decorators.js";

config.debug = true;

const {state} = signal;

const count = state(0);

@customElement('counter-example')
export class BasicExample extends LitElement {
  override render() {
    return html`
      <button @click=${() => count.send(count.get() + 1)}>
        Count: ${watch(count)}
      </button>
    `;
  }
}