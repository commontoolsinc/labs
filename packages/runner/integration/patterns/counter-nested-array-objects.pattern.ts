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

interface EntryDetails {
  note: string;
}

interface NestedEntry {
  id: string;
  label: string;
  value: number;
  details: EntryDetails;
}

interface NestedGroup {
  title: string;
  entries: NestedEntry[];
}

interface NestedArrayArgs {
  groups: Default<NestedGroup[], []>;
}

const getEntryValue = (entry: NestedEntry) =>
  typeof entry.value === "number" ? entry.value : 0;

interface UpdateNestedEvent {
  groupIndex?: number;
  entryIndex?: number;
  delta?: number;
  note?: string;
  label?: string;
}

interface AppendEntryEvent {
  groupIndex?: number;
  label?: string;
  note?: string;
  value?: number;
}

const updateNestedEntry = handler(
  (
    event: UpdateNestedEvent | undefined,
    context: { groups: Cell<NestedGroup[]> },
  ) => {
    if (!event) return;

    const groupIndex = typeof event.groupIndex === "number"
      ? event.groupIndex
      : 0;
    const entryIndex = typeof event.entryIndex === "number"
      ? event.entryIndex
      : 0;

    const groupsValue = context.groups.get();
    if (!Array.isArray(groupsValue)) return;
    if (groupIndex < 0 || groupIndex >= groupsValue.length) return;

    const groupCell = context.groups.key(groupIndex) as Cell<NestedGroup>;
    const entriesCell = groupCell.key("entries") as Cell<NestedEntry[]>;
    const entriesValue = entriesCell.get();
    if (!Array.isArray(entriesValue)) return;
    if (entryIndex < 0 || entryIndex >= entriesValue.length) return;

    const entryCell = entriesCell.key(entryIndex) as Cell<NestedEntry>;
    const valueCell = entryCell.key("value") as Cell<number>;
    const currentValue = valueCell.get() ?? 0;
    const delta = typeof event.delta === "number" ? event.delta : 1;
    valueCell.set(currentValue + delta);

    if (typeof event.label === "string") {
      const labelCell = entryCell.key("label") as Cell<string>;
      labelCell.set(event.label);
    }

    if (typeof event.note === "string") {
      const detailsCell = entryCell.key("details") as Cell<EntryDetails>;
      const noteCell = detailsCell.key("note") as Cell<string>;
      noteCell.set(event.note);
    }
  },
);

const appendNestedEntry = handler(
  (
    event: AppendEntryEvent | undefined,
    context: { groups: Cell<NestedGroup[]> },
  ) => {
    const groupIndex = typeof event?.groupIndex === "number"
      ? event.groupIndex
      : 0;
    const groupsValue = context.groups.get();
    const groupsArray = Array.isArray(groupsValue) ? groupsValue : [];
    if (groupIndex < 0 || groupIndex >= groupsArray.length) return;

    const groupCell = context.groups.key(groupIndex) as Cell<NestedGroup>;
    const entriesCell = groupCell.key("entries") as Cell<NestedEntry[]>;
    const entriesValue = entriesCell.get();
    const length = Array.isArray(entriesValue) ? entriesValue.length : 0;

    entriesCell.push({
      id: `entry-${groupIndex}-${length}`,
      label: event?.label ?? `Item ${length + 1}`,
      value: typeof event?.value === "number" ? event.value : 0,
      details: { note: event?.note ?? "" },
    });
  },
);

const countTotals = (groups: NestedGroup[] | undefined) => {
  const list = Array.isArray(groups) ? groups : [];
  return list.reduce((sum, group) => {
    const entries = Array.isArray(group.entries) ? group.entries : [];
    return sum +
      entries.map(getEntryValue).reduce((total, value) => total + value, 0);
  }, 0);
};

const summarizeGroups = (groups: NestedGroup[] | undefined) => {
  const list = Array.isArray(groups) ? groups : [];
  return list.map((group) => {
    const entries = Array.isArray(group.entries) ? group.entries : [];
    const total = entries
      .map(getEntryValue)
      .reduce((sum, value) => sum + value, 0);
    const notes = entries.map((entry) => entry.details?.note ?? "");
    return { title: group.title, total, notes };
  });
};

export const counterWithNestedArrayObjects = recipe<NestedArrayArgs>(
  "Counter With Nested Array Objects",
  ({ groups }) => {
    const totals = derive(groups, countTotals);
    const summaries = derive(groups, summarizeGroups);
    const allNotes = lift((items: { notes: string[] }[] | undefined) => {
      const collections = Array.isArray(items) ? items : [];
      return collections.flatMap((item) => {
        return item.notes.filter((note) =>
          typeof note === "string" && note !== ""
        );
      });
    })(summaries);

    const headline = str`Nested total ${totals}`;

    return {
      groups,
      totals,
      summaries,
      headline,
      notes: allNotes,
      updateEntry: updateNestedEntry({ groups }),
      appendEntry: appendNestedEntry({ groups }),
    };
  },
);
