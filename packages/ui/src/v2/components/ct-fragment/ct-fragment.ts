/**
 * CTFragment - A transparent wrapper element with display:contents
 *
 * This element behaves like a React Fragment - it doesn't introduce
 * any layout boxes in the DOM tree. Children are rendered as if they
 * were direct children of the fragment's parent.
 *
 * @element ct-fragment
 *
 * @slot - Default slot for fragment content
 *
 * @example
 * <ct-fragment>
 *   <ct-button>Button 1</ct-button>
 *   <ct-button>Button 2</ct-button>
 * </ct-fragment>
 */
export class CTFragment extends HTMLElement {
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

globalThis.customElements.define("ct-fragment", CTFragment);
