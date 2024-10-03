import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-ai-icon")
export class OsAiIcon extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --icon-size: calc(var(--u) * 6);
        display: block;
        width: var(--icon-size);
        height: var(--icon-size);
      }

      :host([iconsize="lg"]) {
        --icon-size: calc(var(--u) * 8);
      }

      .ai-icon {
        display: block;
        width: var(--icon-size);
        height: var(--icon-size);
      }
    `,
  ];

  override render() {
    return html`
      <svg
        class="ai-icon"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="11.0449"
          y="9.04071"
          width="12.3581"
          height="12.3581"
          transform="rotate(45 11.0449 9.04071)"
          fill="black"
        />
        <rect
          x="21.6375"
          y="19.6334"
          width="5.29632"
          height="5.29632"
          transform="rotate(45 21.6375 19.6334)"
          fill="black"
        />
        <rect
          x="21.6375"
          y="5.33334"
          width="7.64156"
          height="7.64156"
          transform="rotate(45 21.6375 5.33334)"
          fill="black"
        />
      </svg>
    `;
  }
}
