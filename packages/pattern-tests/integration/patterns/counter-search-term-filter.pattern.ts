/// <cts-enable />
import {
  type Cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface NamedCounter {
  id: string;
  label: string;
  value: number;
}

interface SearchFilterArgs {
  counters: Default<NamedCounter[], []>;
  search: Default<string, "">;
}

interface CounterUpdateEvent {
  id?: string;
  delta?: number;
  value?: number;
  label?: string;
}

const sanitizeCounterList = (
  entries: readonly NamedCounter[] | undefined,
): NamedCounter[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const safeId = typeof entry?.id === "string" && entry.id.trim()
      ? entry.id
      : `counter-${index}`;
    const safeLabel = typeof entry?.label === "string" && entry.label.trim()
      ? entry.label
      : `Counter ${index + 1}`;
    const rawValue = entry?.value;
    const safeValue = typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : 0;
    return { id: safeId, label: safeLabel, value: safeValue };
  });
};

const sanitizeSearchTerm = (input: string | undefined): string => {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, 64);
};

const setSearchTerm = handler(
  (
    event: { term?: string; query?: string } | string | undefined,
    context: { search: Cell<string> },
  ) => {
    const raw = typeof event === "string" ? event : event?.term ?? event?.query;
    const sanitized = sanitizeSearchTerm(raw);
    context.search.set(sanitized);
  },
);

const resetSearchTerm = handler(
  (_event: unknown, context: { search: Cell<string> }) => {
    context.search.set("");
  },
);

const updateCounterValue = handler(
  (
    event: CounterUpdateEvent | undefined,
    context: { counters: Cell<NamedCounter[]> },
  ) => {
    const list = sanitizeCounterList(context.counters.get());
    if (list.length === 0) return;

    const fallbackId = list[0]?.id;
    const targetId = typeof event?.id === "string" && event.id.trim()
      ? event.id
      : fallbackId;
    if (!targetId) return;

    const hasValue = typeof event?.value === "number" &&
      Number.isFinite(event.value);
    const delta = typeof event?.delta === "number" &&
        Number.isFinite(event.delta)
      ? event.delta
      : 0;
    const nextLabel = typeof event?.label === "string" &&
        event.label.trim()
      ? event.label
      : undefined;

    const updated = list.map((item) => {
      if (item.id !== targetId) return item;
      const base = hasValue ? event.value! : item.value + delta;
      const safeValue = Number.isFinite(base) ? base : item.value;
      return {
        id: item.id,
        label: nextLabel ?? item.label,
        value: safeValue,
      };
    });

    context.counters.set(updated);
  },
);

export const counterWithSearchTermFilter = recipe<SearchFilterArgs>(
  "Counter With Search Term Filter",
  ({ counters, search }) => {
    const sanitizedCounters = lift(sanitizeCounterList)(counters);
    const searchTerm = lift(sanitizeSearchTerm)(search);
    const searchDisplay = lift((term: string) =>
      term.length > 0 ? term : "(all)"
    )(searchTerm);

    const filteringInputs = {
      values: sanitizedCounters,
      term: searchTerm,
    };

    const filtered = lift(
      (
        input: { values: NamedCounter[]; term: string },
      ): NamedCounter[] => {
        const query = input.term.toLowerCase();
        if (!query) return input.values;
        return input.values.filter((item) =>
          item.label.toLowerCase().includes(query)
        );
      },
    )(filteringInputs);

    const totalCount = derive(sanitizedCounters, (values) => values.length);
    const filteredCount = derive(filtered, (values) => values.length);
    const hasMatches = derive(filteredCount, (count) => count > 0);

    const filteredLabels = lift((entries: NamedCounter[]) =>
      entries.map((entry) => `${entry.label} (${entry.value})`)
    )(filtered);

    const summary =
      str`Matches ${filteredCount}/${totalCount} for ${searchDisplay}`;

    return {
      counters,
      search,
      sanitizedCounters,
      searchTerm,
      searchDisplay,
      totalCount,
      filtered,
      filteredCount,
      filteredLabels,
      summary,
      hasMatches,
      setSearch: setSearchTerm({ search }),
      resetSearch: resetSearchTerm({ search }),
      updateCounter: updateCounterValue({ counters }),
    };
  },
);
