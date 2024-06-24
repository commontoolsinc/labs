import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';
import { baseStyles } from './style.js';
import { eventProps } from '../hyperscript/schema-helpers.js';

export const cardContainer = view('common-card-container', {
  background: { type: 'string' },
  ...eventProps(),
});

@customElement("common-card")
export class CommonCardElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .card {
      border: 1px solid #ddd;
      border-radius: var(--radius);
    }
    `
  ];

  override render() {
    return html`
    <article class="card">
      <slot></slot>
    </article>
    `;
  }
}