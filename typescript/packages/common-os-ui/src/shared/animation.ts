/** Create a promise for a timeout  */
export const timeout = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Set a property on an element with a CSS transition.
 * Returns a promise that resolves after the transition completes.
 * The promise is timeout-based rather than `transitionend`-based,
 * so its guaranteed to resolve even if the transition is interrupted.
 * After the transition completes, the transition style is removed. The
 * value style is kept.
 * @returns A Promise that resolves to the element after the transition
 * completes.
 */
export const transition = async <E extends HTMLElement, V>({
  element,
  property,
  duration,
  easing,
  value,
}: {
  element: E;
  property: string;
  duration: number;
  easing: string;
  value: V;
}): Promise<E> => {
  element.style.transition = `${property} ${duration} ${easing}`;
  element.style.setProperty(property, `${value}`);
  await timeout(duration + 0.001);
  element.style.removeProperty("transition");
  return element;
};
