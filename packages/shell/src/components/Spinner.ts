import { css, html, LitElement } from "lit";

// https://cssloaders.github.io/
export class XSpinnerElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: white;
      padding: 1rem;
      --spinner-lowlight: #ccc;
      --spinner-highlight: #999;
    }

    .loader {
      animation: rotate 1s infinite;
      height: 50px;
      width: 50px;
      /* CT ADDITIONS */
      user-select: none;
      margin: 0 auto;
      display: block;
    }
    .loader:before,
    .loader:after {
      border-radius: 50%;
      content: "";
      display: block;
      height: 20px;
      width: 20px;
    }
    .loader:before {
      animation: ball1 1s infinite;
      background-color: var(--spinner-lowlight);
      box-shadow: 30px 0 0 var(--spinner-highlight);
      margin-bottom: 10px;
    }
    .loader:after {
      animation: ball2 1s infinite;
      background-color: var(--spinner-highlight);
      box-shadow: 30px 0 0 var(--spinner-lowlight);
    }

    @keyframes rotate {
      0% {
        transform: rotate(0deg) scale(0.8);
      }
      50% {
        transform: rotate(360deg) scale(1.2);
      }
      100% {
        transform: rotate(720deg) scale(0.8);
      }
    }

    @keyframes ball1 {
      0% {
        box-shadow: 30px 0 0 var(--spinner-highlight);
      }
      50% {
        box-shadow: 0 0 0 var(--spinner-highlight);
        margin-bottom: 0;
        transform: translate(15px, 15px);
      }
      100% {
        box-shadow: 30px 0 0 var(--spinner-highlight);
        margin-bottom: 10px;
      }
    }

    @keyframes ball2 {
      0% {
        box-shadow: 30px 0 0 var(--spinner-lowlight);
      }
      50% {
        box-shadow: 0 0 0 var(--spinner-lowlight);
        margin-top: -20px;
        transform: translate(15px, 15px);
      }
      100% {
        box-shadow: 30px 0 0 var(--spinner-lowlight);
        margin-top: 0;
      }
    }
  `;

  override render() {
    return html`
      <span class="loader"></span>
    `;
  }
}

globalThis.customElements.define("x-spinner", XSpinnerElement);
