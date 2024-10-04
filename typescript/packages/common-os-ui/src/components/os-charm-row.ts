import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-charm-row")
export class OsCharmRow extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --height: calc(var(--u) * 15);
        display: block;
        height: var(--height);
      }

      .charm-row {
        cursor: pointer;
        height: var(--height);
        padding: 0 var(--pad);
        position: relative;

        &::before {
          content: "";
          background-color: var(--bg-scrim);
          top: 0;
          left: 0;
          bottom: 0;
          right: 0;
          opacity: 0;
          position: absolute;
          pointer-events: none;
          transition: opacity var(--dur-lg) var(--ease-out-expo);
        }

        &:hover::before,
        &:active::before,
        :host([activated]) &::before {
          opacity: 1;
        }

        .charm-row-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: calc(var(--u) * 90);
        }

        & > .charm-row-extra {
          opacity: 0;
          transition: opacity var(--dur-md) var(--ease-out-expo);
        }

        &:hover > .charm-row-extra {
          opacity: 1;
        }
      }
    `,
  ];

  @property({ type: String })
  icon = "";

  @property({ type: String })
  text = "";

  override render() {
    return html`
      <div class="charm-row toolbar">
        <div class="hstack gap-sm toolbar-start">
          <os-charm-icon
            class="charm-row-icon"
            icon="${this.icon}"
          ></os-charm-icon>
          <div class="charm-row-text body">${this.text}</div>
        </div>
        <div class="hstack gap-sm toolbar-end charm-row-extra">
          <os-icon-button-plain icon="more_vert"></os-icon-button-plain>
        </div>
      </div>
    `;
  }
}

@customElement("os-charm-row-group")
export class OsCharmRowGroup extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
    `,
  ];

  override render() {
    return html`
      <div class="vstack">
        <slot></slot>
      </div>
    `;
  }
}
