import { LitElement, html } from 'lit-element';
import { customElement, property } from "lit/decorators.js";
import { CellImpl, isCell, cell, CellProxy } from "@commontools/common-runner";

const context = cell({ exampleKey: 123 })

@customElement('common-iframe')
export class CommonIframe extends LitElement {
  @property({ type: String }) src = '';
  @property({ type: Object }) context?: CellProxy<any>;

  private iframeElement: HTMLIFrameElement | null = null;

  override firstUpdated() {
    this.iframeElement = this.shadowRoot?.querySelector('iframe') || null;
    window.addEventListener('message', this.handleMessage.bind(this));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this.handleMessage.bind(this));
  }

  handleMessage(event: MessageEvent) {
    console.log('Received message', event);
    if (event.source === this.iframeElement?.contentWindow) {
      const { type, key, data } = event.data;
      if (typeof key !== 'string') {
        console.error('Invalid key type. Expected string.');
        return;
      }
      console.log({ type, key, data }, this.context, isCell(this.context))
      if (type === 'read' && this.context) {
        const value = this.context[key];
        console.log('readResponse', key, value)
        this.iframeElement?.contentWindow?.postMessage({ type: 'readResponse', key, data: value }, '*');
      } else if (type === 'write' && this.context) {
        this.context[key] = data;
      }
    }
  }

  override render() {
    return html`
      <iframe
        sandbox="allow-scripts"
        .srcdoc=${this.src}
        height="512px"
        width="100%"
        @load=${() => {
          if (this.iframeElement?.contentWindow) {
            this.iframeElement.contentWindow.postMessage({ type: 'init' }, '*');
          }
        }}
      ></iframe>
    `;
  }
}
