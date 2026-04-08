export interface EventProvenance {
  origin: "dom";
  trusted: boolean;
}

export const getEventProvenance = (
  event: Pick<Event, "isTrusted">,
): EventProvenance | undefined => {
  if (event.isTrusted) {
    return {
      origin: "dom",
      trusted: true,
    };
  }
  return undefined;
};
