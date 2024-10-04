let slowAnimations = false;

/** Set slow animations for debugging */
export const setSlowAnimations = (isSlow: boolean) => {
  slowAnimations = isSlow;
};

/** @returns 10s if slow animations is turned on, otherwise returns `ms` */
export const slowable = (ms: number) => (slowAnimations ? 10000 : ms);

export const durationSm = 250;
export const durationMd = 350;
export const durationLg = 350;

/** Create a promise for a timeout  */
export const timeout = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type CubicBezier = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export const cubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): CubicBezier => Object.freeze({ x1, y1, x2, y2 });

export const easeOutCubic = cubicBezier(0.215, 0.61, 0.355, 1);
export const easeOutExpo = cubicBezier(0.19, 1, 0.22, 1);

/** Create a cubic  */
export const cubicBezierCss = ({ x1, y1, x2, y2 }: CubicBezier) =>
  `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;

export const easeOutCubicCss = cubicBezierCss(easeOutCubic);
export const easeOutExpoCss = cubicBezierCss(easeOutExpo);

export type Transition = {
  property: string;
  duration: number;
  delay: number;
  easing: string;
  from?: string;
  to: string;
};

export const transition = ({
  property,
  from,
  to,
  duration = durationMd,
  delay = 0,
  easing = easeOutCubicCss,
}: {
  property: string;
  from?: any;
  to: any;
  duration?: number;
  delay?: number;
  easing?: string;
}): Transition => ({
  property,
  from: from != null ? `${from}` : undefined,
  to: `${to}`,
  duration: slowable(duration),
  easing,
  delay,
});

/** Get full transition duration by finding the longest duration + delay */
export const fullTransitionDuration = (
  transitions: Array<Transition>,
): number => Math.max(...transitions.map((t) => t.duration + t.delay));

const transitionsToCssRule = (transitions: Array<Transition>) =>
  transitions
    .map((t) => `${t.property} ${t.duration}ms ${t.easing} ${t.delay}ms`)
    .join(", ");

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
export const setTransitions = async <E extends HTMLElement>(
  element: E,
  transitions: Array<Transition>,
): Promise<E> => {
  const fullDuration = fullTransitionDuration(transitions);
  element.style.removeProperty("transition");
  for (const t of transitions) {
    if (t.from != null) {
      element.style.setProperty(t.property, t.from);
    }
  }
  await timeout(0);
  element.style.transition = transitionsToCssRule(transitions);
  for (const t of transitions) {
    element.style.setProperty(t.property, t.to);
  }
  await timeout(fullDuration);
  element.style.removeProperty("transition");
  return element;
};
