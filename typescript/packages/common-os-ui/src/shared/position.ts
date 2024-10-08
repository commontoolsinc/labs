import { computePosition, flip } from "@floating-ui/dom";
import { animationFrame } from "./dom.js";

export type Rect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/**
 * A rect that can be easily constructed with
 * a ProseMirror rect (https://prosemirror.net/docs/ref/#view.EditorView.coordsAtPos)
 * and used as a virtual element for Floating UI (https://floating-ui.com/docs/virtual-elements)
 */
export class VirtualRect {
  #top: number;
  #left: number;
  #bottom: number;
  #right: number;

  constructor(top: number, right: number, bottom: number, left: number) {
    this.#top = top;
    this.#left = left;
    this.#bottom = bottom;
    this.#right = right;
  }

  get top() {
    return this.#top;
  }

  get left() {
    return this.#left;
  }

  get bottom() {
    return this.#bottom;
  }

  get right() {
    return this.#right;
  }

  get x() {
    return this.#left;
  }

  get y() {
    return this.#top;
  }

  get width() {
    return this.#right - this.#left;
  }

  get height() {
    return this.#bottom - this.#top;
  }

  getBoundingClientRect() {
    return this;
  }
}

export const positionMenu = async (
  menu: HTMLElement,
  { top, right, bottom, left }: Rect,
) => {
  const { x, y } = await computePosition(
    new VirtualRect(top, right, bottom, left),
    menu,
    {
      strategy: "fixed",
      placement: "bottom-start",
      middleware: [flip()],
    },
  );

  await animationFrame();

  menu.style.position = "fixed";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
};
