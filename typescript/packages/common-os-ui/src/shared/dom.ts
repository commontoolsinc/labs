export const classes = (classRecord: Record<string, boolean>) => {
  let toggledClasses: Array<string> = [];
  for (const [className, isActive] of Object.entries(classRecord)) {
    if (isActive) toggledClasses.push(className);
  }
  return toggledClasses.join(" ");
};

export const animationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export const toggleHidden = async (element: HTMLElement, isHidden: boolean) => {
  await animationFrame();
  element.ariaHidden = isHidden ? "true" : "false";
  element.style.opacity = isHidden ? "0" : "1";
  element.style.pointerEvents = isHidden ? "none" : "all";
};
