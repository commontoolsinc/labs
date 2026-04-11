export interface EventProvenance {
  origin: "dom";
  trusted: boolean;
  ui?: EventUiProvenance;
}

export interface EventUiProvenance {
  pattern?: string;
  eventIntegrity?: string[];
}

export const getEventProvenance = (
  event: Pick<Event, "isTrusted">,
  target?: EventTarget | null,
): EventProvenance | undefined => {
  if (event.isTrusted) {
    const provenance: EventProvenance = {
      origin: "dom",
      trusted: true,
    };
    const ui = getEventUiProvenance(target);
    if (ui) {
      provenance.ui = ui;
    }
    return provenance;
  }
  return undefined;
};

const getEventUiProvenance = (
  target: EventTarget | null | undefined,
): EventUiProvenance | undefined => {
  let current: unknown = target;
  let pattern: string | undefined;
  const eventIntegrity = new Set<string>();
  while (current && typeof current === "object") {
    const dataset = "dataset" in current ? current.dataset : undefined;
    if (dataset && typeof dataset === "object") {
      if (
        pattern === undefined &&
        "uiPattern" in dataset &&
        typeof dataset.uiPattern === "string"
      ) {
        pattern = dataset.uiPattern;
      }
      const labels = "uiEventIntegrity" in dataset &&
          typeof dataset.uiEventIntegrity === "string"
        ? splitIntegrityLabels(dataset.uiEventIntegrity)
        : undefined;
      if (labels) {
        labels.forEach((label) => eventIntegrity.add(label));
      }
    }
    current = "parentNode" in current ? current.parentNode : undefined;
  }
  return pattern || eventIntegrity.size > 0
    ? {
      ...(pattern ? { pattern } : {}),
      ...(eventIntegrity.size > 0
        ? { eventIntegrity: [...eventIntegrity] }
        : {}),
    }
    : undefined;
};

const splitIntegrityLabels = (value: string): string[] | undefined => {
  const labels = value.split(/[\s,]+/).filter((label) => label.length > 0);
  return labels.length > 0 ? labels : undefined;
};
