import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { todoAppMockup } from '../data'
import { doLLM } from '../llm'

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]

  @state() graph = todoAppMockup as any
  @state() userInput = ''

  async appendMessage() {
    const newGraph = { ...this.graph }
    const id = 'new' + (Math.floor(Math.random() * 1000))
    const input = `${this.userInput}`

    const newNode = {
      id,
      messages: [
        {
          role: 'user',
          content: input
        }
      ]
    }

    newGraph.nodes.push(newNode);
    newGraph.order.push(id);
    this.graph = newGraph;
    this.userInput = '';

    const result = await doLLM(input, '', null)
    const message = result?.choices[0]?.message
    if (message) {
      newNode.messages.push(message);
    }

    this.graph = JSON.parse(JSON.stringify(newGraph));
  }

  render() {
    const setUserInput = (input: string) => {
      this.userInput = input
    }

    return html`
      <com-app-grid>
        <com-chat slot="main">
            <com-thread slot="main" .graph=${this.graph}></com-thread>
            <div slot="footer">
                <com-unibox>
                    <com-editor slot="main" .value=${this.userInput} .setValue=${setUserInput}></com-editor>
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
