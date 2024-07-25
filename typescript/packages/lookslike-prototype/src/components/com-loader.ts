import { LitElement, html, css } from "lit-element";
import { customElement } from "lit/decorators.js";

const styles = css`
  :host {
    display: block;
  }

  .loader {
    width: 32px;
    height: 32px;
    display: block;
    margin: 10px auto;
    position: relative;
    color: #fff;
    box-sizing: border-box;
    animation: rotation 1s linear infinite;
  }
  .loader::after,
  .loader::before {
    content: "";
    box-sizing: border-box;
    position: absolute;
    width: 16px;
    height: 16px;
    top: 50%;
    left: 50%;
    transform: scale(0.5) translate(0, 0);
    background-color: #fff;
    border-radius: 50%;
    animation: animloader 3s infinite ease-in-out;
  }
  .loader::before {
    background-color: #ddd;
    transform: scale(0.5) translate(-32px, -32px);
  }

  @keyframes rotation {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
  @keyframes animloader {
    50% {
      transform: scale(1) translate(-50%, -50%);
    }
  }
`;

@customElement("com-loader")
export class ComLoader extends LitElement {
  static styles = [styles];

  override render() {
    return html` <span class="loader"></span> `;
  }
}
