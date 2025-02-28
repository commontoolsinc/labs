/** Create a class string using a record of classnames to toggle-states */
export const classes = (classRecord: Record<string, boolean>) => {
  let toggledClasses: Array<string> = [];
  for (const [className, isActive] of Object.entries(classRecord)) {
    if (isActive) toggledClasses.push(className);
  }
  return toggledClasses.join(" ");
};

/** Get a promise for the next animationframe */
export const animationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export const toggleInvisible = async (
  element: HTMLElement,
  isInvisible: boolean,
) => {
  element.ariaHidden = isInvisible ? "true" : "false";
  element.classList.toggle("invisible", isInvisible);
};

/**
 * Attach an event listener to an element.
 * @returns a cleanup function to remove the listener.
 */
export const on = (
  element: EventTarget,
  event: string,
  callback: (event: unknown) => void,
  options: AddEventListenerOptions | undefined = undefined,
) => {
  element.addEventListener(event, callback, options);
  return () => element.removeEventListener(event, callback, options);
};
