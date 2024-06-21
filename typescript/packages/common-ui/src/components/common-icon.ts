import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { view } from '../hyperscript/render.js';
import { eventProps } from "../hyperscript/schema-helpers.js";
import { iconStyles } from './style.js';

export const icon = view('common-icon', {
  ...eventProps()
})

@customElement("common-icon")
export class CommonIconElement extends LitElement {
  static override styles = [
    iconStyles,
    css`
    :host {
      display: block;
      --icon-box-size: 40px;
      --icon-size: 24px;
      width: var(--icon-box-size);
      height: var(--icon-box-size);
      overflow: hidden;
    }

    .icon {
      align-items: center;
      display: flex;
      font-size: var(--icon-size);
      width: 100%;
      height: 100%;
      text-align: center;
      justify-content: center;
    }
    `
  ];

  override render() {
    return html`
    <div class="icon material-symbols-outlined"><slot></slot></div>
    `;
  }
}