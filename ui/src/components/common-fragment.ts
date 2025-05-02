export class CommonFragmentElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }
}

customElements.define("common-fragment", CommonFragmentElement);
