import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { todoAppMockup } from '../data'

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]

  @state() graph = todoAppMockup as any

  appendMessage() {
    const newGraph = { ...this.graph }
    const id = 'new' + (Math.floor(Math.random() * 1000))

    newGraph.nodes.push({
      id,
      messages: [
        {
          role: 'user',
          content: 'new message'
        }
      ],
      definition: {}
    });

    newGraph.order.push(id);
    this.graph = newGraph;
  }

  render() {
    return html`
      <com-app-grid>
        <com-chat slot="main">
            <com-thread slot="main" .graph=${this.graph}></com-thread>
            <div slot="footer">
                <com-unibox>
                    <com-editor slot="main"></com-editor>
                    <com-button slot="end" .action=${() => this.appendMessage()}>Send</com-button>
                </com-unibox>
            </div>
        </com-chat>
        <div slot="sidebar">

        </div>
    </com-app-grid>
    `
  }
}
