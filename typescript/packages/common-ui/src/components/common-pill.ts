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
      --pill-background: transparent;
      --pill-border: var(--button-background);
      --pill-color: #fff;
      --pill-height: 40px;
      --pill-width: min-content;
      display: block;
      width: var(--pill-width);
    }

    .pill {
      align-items: center;
      appearance: none;
      background-color: var(--pill-background);
      border: 1px solid var(--pill-border);
      box-sizing: border-box;
      border-radius: calc(var(--pill-height) / 2);
      cursor: pointer;
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