import { html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

const TAG_NAME = "ct-piece";

/**
 * CTPiece - Container element that provides piece context to child components
 *
 * @element ct-piece
 *
 * @attr {string} piece-id - The ID of the piece
 * @attr {string} space-name - The name of the space
 *
 * @slot - Default slot for piece content
 *
 * @example
 * <ct-piece piece-id="abc123" space-name="my-space">
 *   <ct-button>Click Me</ct-button>
 * </ct-piece>
 */
export class CTPiece extends BaseElement {
  declare pieceId: string | null;
  declare spaceName: string | null;

  static findPieceContainer(element: HTMLElement): CTPiece | null {
    const tagName = TAG_NAME.toUpperCase();
    let currentNode: HTMLElement | null = element;
    while (currentNode) {
      if (currentNode.tagName === tagName) {
        return currentNode as CTPiece;
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
    pieceId: { required: true, type: String, attribute: "piece-id" },
    spaceName: { required: true, type: String, attribute: "space-name" },
  };

  constructor() {
    super();
    this.pieceId = null;
    this.spaceName = null;
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

globalThis.customElements.define("ct-piece", CTPiece);
