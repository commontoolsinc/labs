import { LitElement, html, css } from 'lit-element';
import { customElement, property } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';
import { baseStyles } from './style.js';
import { eventProps } from '../hyperscript/schema-helpers.js';

export const pill = view('common-card', {
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
      --card-background: var(--secondary-background);
      --card-color: var(--color);
    }

    .card {
      background-color: var(--card-background);
      color: var(--card-color);
      border-radius: var(--radius);
      padding: var(--pad);
    }
    `
  ];

  @property({ type: String }) background: string = 'var(--secondary-background)';

  override render() {
    return html`
    <article class="card" style="--card-background: ${this.background};">
      <slot></slot>
    </article>
    `;
  }
}