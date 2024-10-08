import fastdom from "./fastdom.js";

/**
 * Position a menu element against an anchor element.
 * Will pin menu to the left/bottom of anchor by default, unless the menu would
 * exceed the window bounds, in which case it will pin the menu to the
 * top/right.
 */
export const positionMenu = (anchor: HTMLElement, menu: HTMLElement) => {
  fastdom(() => {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    const isMenuWidthOutOfBounds =
      anchorRect.left + menuRect.width > windowWidth;
    const isMenuHeightOutOfBounds =
      anchorRect.bottom + menuRect.height > windowHeight;

    return () => {
      menu.style.position = "absolute";
      if (!isMenuWidthOutOfBounds) {
        menu.style.left = `${anchorRect.left}px`;
        menu.style.right = `initial`;
      } else {
        menu.style.left = `initial`;
        menu.style.right = `${anchorRect.right}px`;
      }
      if (!isMenuHeightOutOfBounds) {
        menu.style.top = `${anchorRect.bottom}px`;
        menu.style.bottom = `initial`;
      } else {
        menu.style.top = `initial`;
        menu.style.bottom = `${anchorRect.top}px`;
      }
    };
  });
};
