export class CommonFragmentElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" })
      // Add a slot to display the children
      .appendChild(document.createElement("slot"));
  }
}

customElements.define("common-fragment", CommonFragmentElement);
