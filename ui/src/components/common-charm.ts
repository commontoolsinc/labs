import { html, LitElement } from "lit";

const TAG_NAME = "common-charm";

export class CommonCharmElement extends LitElement {
  declare charmId: string | null;
  declare spaceName: string | null;

  static findCharmContainer(element: HTMLElement): CommonCharmElement | null {
    const tagName = TAG_NAME.toUpperCase();
    let currentNode: HTMLElement | null = element;
    while (currentNode) {
      if (currentNode.tagName === tagName) {
        return currentNode as CommonCharmElement;
      }
      const parent: HTMLElement | null = currentNode.parentElement;
      if (parent) {
        currentNode = parent;
      } else {
        // No parent found; check for a root node, which breaks
        // out of shadow DOM
        const root = currentNode.getRootNode({ composed: false });
        if (root instanceof ShadowRoot) {
          currentNode = root.host as HTMLElement;
        } else {
          currentNode = null;
        }
      }
    }
    return null;
  }

  static override properties = {
    charmId: { required: true, type: String, attribute: "charm-id" },
    spaceName: { required: true, type: String, attribute: "space-name" },
  };

  constructor() {
    super();
    this.charmId = null;
    this.spaceName = null;
  }

  override render() {
    return html`<slot></slot>`;
  }
}

globalThis.customElements.define(
  "common-charm",
  CommonCharmElement,
);
