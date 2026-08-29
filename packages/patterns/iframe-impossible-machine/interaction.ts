/** Keeps embedded controls out of React Flow's node-selection lifecycle. */
export function stopNodeControlPropagation(
  event: Pick<Event, "stopPropagation">,
): void {
  event.stopPropagation();
}
