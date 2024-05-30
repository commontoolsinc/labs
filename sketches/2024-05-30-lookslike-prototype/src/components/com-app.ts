import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { todoAppMockup } from '../data'

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]

  @state() graph = todoAppMockup as any
  @state() userInput = ''

  appendMessage() {
    const newGraph = { ...this.graph }
    const id = 'new' + (Math.floor(Math.random() * 1000))

    console.log('push message', this.userInput)

    newGraph.nodes.push({
      id,
      messages: [
        {
          role: 'user',
          content: this.userInput
        }
      ],
      definition: {}
    });

    newGraph.order.push(id);
    this.graph = newGraph;
    // this.userInput = ''
  }

  onInput(text) {
    this.userInput = text
    console.log(this.userInput)
  }

  render() {
    return html`
      <com-app-grid>
        <com-chat slot="main">
            <com-thread slot="main" .graph=${this.graph}></com-thread>
            <div slot="footer">
                <com-unibox>
                    <com-editor slot="main" .value=${this.userInput} .onInput=${(v) => this.onInput(v)}></com-editor>
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
