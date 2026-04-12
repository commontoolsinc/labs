export interface EventProvenance {
  origin: "dom";
  trusted: boolean;
  ui?: EventUiProvenance;
}

export interface EventUiProvenance {
  pattern?: string;
  eventIntegrity?: string[];
}

type EventLike = Pick<Event, "isTrusted"> & {
  composedPath?: () => readonly unknown[];
};

const UI_CONTRACT_DATASET_KEYS = [
  "uiAction",
  "uiSurface",
  "uiRole",
  "uiDisclosureKind",
] as const;

export const getEventProvenance = (
  event: EventLike,
  target?: EventTarget | null,
): EventProvenance | undefined => {
  if (event.isTrusted) {
    const provenance: EventProvenance = {
      origin: "dom",
      trusted: true,
    };
    const ui = getEventUiProvenance(event, target);
    if (ui) {
      provenance.ui = ui;
    }
    return provenance;
  }
  return undefined;
};

export const getEventUiContractDataset = (
  event: { composedPath?: () => readonly unknown[] },
  target?: EventTarget | null,
): Record<string, string> | undefined => {
  for (const node of getEventPath(event, target)) {
    const dataset = readDataset(node);
    if (
      dataset &&
      UI_CONTRACT_DATASET_KEYS.some((key) => key in dataset)
    ) {
      return dataset;
    }
  }
  return readDataset(target);
};

const getEventUiProvenance = (
  event: { composedPath?: () => readonly unknown[] },
  target: EventTarget | null | undefined,
): EventUiProvenance | undefined => {
  let pattern: string | undefined;
  const eventIntegrity = new Set<string>();
  for (const current of getEventPath(event, target)) {
    const dataset = readDataset(current);
    if (dataset) {
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

const getEventPath = (
  event: { composedPath?: () => readonly unknown[] },
  target: EventTarget | null | undefined,
): readonly unknown[] => {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    if (Array.isArray(path) && path.length > 0) {
      return path;
    }
  }

  const path: unknown[] = [];
  let current: unknown = target;
  while (current && typeof current === "object") {
    path.push(current);
    current = "parentNode" in current ? current.parentNode : undefined;
  }
  return path;
};

const readDataset = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || !("dataset" in value)) {
    return undefined;
  }
  const source = value.dataset;
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const dataset: Record<string, string> = {};
  for (const key in source) {
    dataset[key] = String((source as Record<string, unknown>)[key]);
  }
  return Object.keys(dataset).length > 0 ? dataset : undefined;
};

const splitIntegrityLabels = (value: string): string[] | undefined => {
  const labels = value.split(/[\s,]+/).filter((label) => label.length > 0);
  return labels.length > 0 ? labels : undefined;
};
