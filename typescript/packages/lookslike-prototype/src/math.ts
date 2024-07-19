export function mix(target: number, current: number, ratio: number): number {
  return ratio * target + (1 - ratio) * current;
}
