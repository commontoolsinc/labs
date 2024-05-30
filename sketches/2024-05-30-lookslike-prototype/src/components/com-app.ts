import { LitElement, html } from 'lit-element'
import { customElement, property } from 'lit/decorators.js'
import { base } from '../styles'

import { todoAppMockup } from '../data'

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]



  render() {
    return html`
      <com-app-grid>
        <com-chat slot="main">
            <com-thread slot="main" .graph=${todoAppMockup}></com-thread>
            <div slot="footer">
                <com-unibox>
                    <com-editor slot="main"></com-editor>
                    <com-button slot="end">Send</com-button>
                </com-unibox>
            </div>
        </com-chat>
        <div slot="sidebar">

        </div>
    </com-app-grid>
    `
  }
}
