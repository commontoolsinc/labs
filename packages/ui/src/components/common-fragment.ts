export class CommonFragmentElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" })
      // Add a slot to display the children
      .appendChild(document.createElement("slot"));
  }

  // Tell engine to ignore this element for layout purposes
  connectedCallback() {
    this.style.display = "contents";
  }
}

globalThis.customElements.define("common-fragment", CommonFragmentElement);
