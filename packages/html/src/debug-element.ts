const DEBUG_BORDER_WIDTH = 5;
const ANIMATION_DURATION_MS = 1500;
const ANIMATION_FALLOFF_PERCENT = 0.5;

export type AnimationType = "created" | "render" | "moved";

const RED = `rgba(255,0,0,1)`;
const GREEN = `rgba(0,255,0,1)`;
const BLUE = `rgba(0,0,255,1)`;
const BLACK = `rgba(0,0,0,1)`;
const TypeToColor: Record<AnimationType, string> = {
  "created": RED,
  "moved": BLUE,
  "render": GREEN,
};

const style = (color: string) => `${color} ${DEBUG_BORDER_WIDTH}px solid`;

export function animate(
  element: HTMLElement,
  type: AnimationType = "render",
  duration: number = ANIMATION_DURATION_MS,
) {
  const color = type && TypeToColor[type];
  element.animate([
    { outline: style(color) },
    { outline: style(color), offset: ANIMATION_FALLOFF_PERCENT },
    { outline: style(BLACK) },
  ], duration);
}
