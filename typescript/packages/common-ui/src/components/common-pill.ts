import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';
import { baseStyles } from './style.js';
import { eventProps } from '../hyperscript/schema-helpers.js';

export const pill = view('common-pill', {
  ...eventProps(),
});

@customElement("common-pill")
export class CommonButtonElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      --pill-background: #000;
      --pill-color: #fff;
      --pill-height: 40px;
      --pill-width: min-content;
      display: block;
      width: var(--pill-width);
    }

    .pill {
      align-items: center;
      appearance: none;
      background-color: var(--button-background);
      border: 0;
      box-sizing: border-box;
      border-radius: var(--radius);
      color: var(--button-color);
      display: flex;
      font-size: var(--body-size);
      height: var(--button-height);
      justify-content: center;
      overflow: hidden;
      line-height: 20px;
      padding: 8px 20px;
      text-align: center;
      text-wrap: nowrap;
      width: 100%;
    }
    `
  ];

  override render() {
    return html`
    <button class="pill">
      <slot></slot>
    </button>
    `;
  }
}