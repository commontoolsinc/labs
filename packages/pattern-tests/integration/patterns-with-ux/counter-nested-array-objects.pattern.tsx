/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
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

// UI-specific handlers
const incrementEntry = handler(
  (
    _event: unknown,
    context: {
      groups: Cell<NestedGroup[]>;
      groupIndexField: Cell<string>;
      entryIndexField: Cell<string>;
    },
  ) => {
    const groupIndex = Number(context.groupIndexField.get());
    const entryIndex = Number(context.entryIndexField.get());

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
    valueCell.set(currentValue + 1);
  },
);

const decrementEntry = handler(
  (
    _event: unknown,
    context: {
      groups: Cell<NestedGroup[]>;
      groupIndexField: Cell<string>;
      entryIndexField: Cell<string>;
    },
  ) => {
    const groupIndex = Number(context.groupIndexField.get());
    const entryIndex = Number(context.entryIndexField.get());

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
    valueCell.set(currentValue - 1);
  },
);

const addNewEntry = handler(
  (
    _event: unknown,
    context: {
      groups: Cell<NestedGroup[]>;
      groupIndexField: Cell<string>;
      labelField: Cell<string>;
      noteField: Cell<string>;
    },
  ) => {
    const groupIndex = Number(context.groupIndexField.get());
    const label = context.labelField.get();
    const note = context.noteField.get();

    const groupsValue = context.groups.get();
    const groupsArray = Array.isArray(groupsValue) ? groupsValue : [];
    if (groupIndex < 0 || groupIndex >= groupsArray.length) return;

    const groupCell = context.groups.key(groupIndex) as Cell<NestedGroup>;
    const entriesCell = groupCell.key("entries") as Cell<NestedEntry[]>;
    const entriesValue = entriesCell.get();
    const length = Array.isArray(entriesValue) ? entriesValue.length : 0;

    entriesCell.push({
      id: `entry-${groupIndex}-${length}`,
      label: typeof label === "string" && label.trim() !== ""
        ? label
        : `Item ${length + 1}`,
      value: 0,
      details: { note: typeof note === "string" ? note : "" },
    });

    // Clear form fields
    context.labelField.set("");
    context.noteField.set("");
  },
);

const updateEntryLabel = handler(
  (
    _event: unknown,
    context: {
      groups: Cell<NestedGroup[]>;
      groupIndexField: Cell<string>;
      entryIndexField: Cell<string>;
      labelField: Cell<string>;
    },
  ) => {
    const groupIndex = Number(context.groupIndexField.get());
    const entryIndex = Number(context.entryIndexField.get());
    const label = context.labelField.get();

    if (typeof label !== "string" || label.trim() === "") return;

    const groupsValue = context.groups.get();
    if (!Array.isArray(groupsValue)) return;
    if (groupIndex < 0 || groupIndex >= groupsValue.length) return;

    const groupCell = context.groups.key(groupIndex) as Cell<NestedGroup>;
    const entriesCell = groupCell.key("entries") as Cell<NestedEntry[]>;
    const entriesValue = entriesCell.get();
    if (!Array.isArray(entriesValue)) return;
    if (entryIndex < 0 || entryIndex >= entriesValue.length) return;

    const entryCell = entriesCell.key(entryIndex) as Cell<NestedEntry>;
    const labelCell = entryCell.key("label") as Cell<string>;
    labelCell.set(label);

    context.labelField.set("");
  },
);

const updateEntryNote = handler(
  (
    _event: unknown,
    context: {
      groups: Cell<NestedGroup[]>;
      groupIndexField: Cell<string>;
      entryIndexField: Cell<string>;
      noteField: Cell<string>;
    },
  ) => {
    const groupIndex = Number(context.groupIndexField.get());
    const entryIndex = Number(context.entryIndexField.get());
    const note = context.noteField.get();

    if (typeof note !== "string") return;

    const groupsValue = context.groups.get();
    if (!Array.isArray(groupsValue)) return;
    if (groupIndex < 0 || groupIndex >= groupsValue.length) return;

    const groupCell = context.groups.key(groupIndex) as Cell<NestedGroup>;
    const entriesCell = groupCell.key("entries") as Cell<NestedEntry[]>;
    const entriesValue = entriesCell.get();
    if (!Array.isArray(entriesValue)) return;
    if (entryIndex < 0 || entryIndex >= entriesValue.length) return;

    const entryCell = entriesCell.key(entryIndex) as Cell<NestedEntry>;
    const detailsCell = entryCell.key("details") as Cell<EntryDetails>;
    const noteCell = detailsCell.key("note") as Cell<string>;
    noteCell.set(note);

    context.noteField.set("");
  },
);

export const counterWithNestedArrayObjectsUx = recipe<NestedArrayArgs>(
  "Counter With Nested Array Objects (UX)",
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

    // Form fields for UI interactions
    const groupIndexField = cell<string>("0");
    const entryIndexField = cell<string>("0");
    const labelField = cell<string>("");
    const noteField = cell<string>("");

    // UI handlers
    const increment = incrementEntry({
      groups,
      groupIndexField,
      entryIndexField,
    });
    const decrement = decrementEntry({
      groups,
      groupIndexField,
      entryIndexField,
    });
    const addEntry = addNewEntry({
      groups,
      groupIndexField,
      labelField,
      noteField,
    });
    const updateLabel = updateEntryLabel({
      groups,
      groupIndexField,
      entryIndexField,
      labelField,
    });
    const updateNote = updateEntryNote({
      groups,
      groupIndexField,
      entryIndexField,
      noteField,
    });

    // Name for the charm
    const name = str`Nested Groups (${totals} total)`;

    // UI Component
    const ui = (
      <ct-card style="max-width: 900px; margin: 0 auto; padding: 1.5rem;">
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          {/* Header */}
          <div style="text-align: center;">
            <h2 style="margin: 0 0 0.5rem 0; color: #1a1a1a;">
              Nested Array Objects Counter
            </h2>
            <div style="font-size: 1.5rem; font-weight: 700; color: #2563eb;">
              Grand Total: {totals}
            </div>
          </div>

          {/* Groups Display */}
          <ct-card style="background: #f8fafc; border: 1px solid #e2e8f0;">
            <h3 style="margin: 0 0 1rem 0; color: #334155;">
              Groups & Entries
            </h3>
            {lift((grps: NestedGroup[] | undefined) => {
              if (!grps || !Array.isArray(grps) || grps.length === 0) {
                return (
                  <div style="padding: 2rem; text-align: center; color: #64748b;">
                    No groups yet. Initialize with data to get started.
                  </div>
                );
              }

              const groupElements = [];
              for (let gi = 0; gi < grps.length; gi++) {
                const group = grps[gi];
                const entries = Array.isArray(group.entries)
                  ? group.entries
                  : [];
                const groupTotal = entries.reduce(
                  (sum, e) => sum + (typeof e.value === "number" ? e.value : 0),
                  0,
                );

                const entryElements = [];
                for (let ei = 0; ei < entries.length; ei++) {
                  const entry = entries[ei];
                  const noteText = entry.details?.note ?? "";
                  const bgColor = ei % 2 === 0 ? "#ffffff" : "#f1f5f9";
                  const itemStyle =
                    "display: flex; gap: 1rem; align-items: center; padding: 0.75rem; background: " +
                    bgColor + "; border-radius: 0.375rem;";

                  entryElements.push(
                    <div key={entry.id} style={itemStyle}>
                      <div style="font-family: monospace; color: #64748b; font-size: 0.875rem; min-width: 80px;">
                        [{String(gi)},{String(ei)}]
                      </div>
                      <div style="flex: 1;">
                        <div style="font-weight: 600; color: #1e293b;">
                          {entry.label}
                        </div>
                        {noteText !== ""
                          ? (
                            <div style="font-size: 0.875rem; color: #64748b; margin-top: 0.25rem;">
                              Note: {noteText}
                            </div>
                          )
                          : null}
                      </div>
                      <div style="font-size: 1.25rem; font-weight: 700; color: #2563eb; min-width: 60px; text-align: right; font-family: monospace;">
                        {String(entry.value)}
                      </div>
                    </div>,
                  );
                }

                const groupCardStyle =
                  "background: white; border: 2px solid #3b82f6; border-radius: 0.5rem; padding: 1rem;";
                groupElements.push(
                  <ct-card key={group.title} style={groupCardStyle}>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; padding-bottom: 0.75rem; border-bottom: 2px solid #e2e8f0;">
                      <h4 style="margin: 0; color: #1e293b; font-size: 1.125rem;">
                        {group.title}
                      </h4>
                      <div style="background: #3b82f6; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; font-family: monospace;">
                        Σ = {String(groupTotal)}
                      </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                      {entryElements}
                    </div>
                  </ct-card>,
                );
              }

              return (
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                  {groupElements}
                </div>
              );
            })(groups)}
          </ct-card>

          {/* Controls */}
          <ct-card style="background: #fefce8; border: 1px solid #fde047;">
            <h3 style="margin: 0 0 1rem 0; color: #713f12;">Controls</h3>

            {/* Entry Selection */}
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
              <div>
                <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                  Group Index
                </label>
                <ct-input
                  $value={groupIndexField}
                  placeholder="0"
                  style="width: 100%;"
                />
              </div>
              <div>
                <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                  Entry Index
                </label>
                <ct-input
                  $value={entryIndexField}
                  placeholder="0"
                  style="width: 100%;"
                />
              </div>
            </div>

            {/* Increment/Decrement */}
            <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem;">
              <ct-button
                onClick={increment}
                style="flex: 1; background: #10b981; color: white;"
              >
                ➕ Increment Entry
              </ct-button>
              <ct-button
                onClick={decrement}
                style="flex: 1; background: #ef4444; color: white;"
              >
                ➖ Decrement Entry
              </ct-button>
            </div>

            {/* Add New Entry */}
            <div style="border-top: 1px solid #fde047; padding-top: 1rem;">
              <h4 style="margin: 0 0 0.75rem 0; color: #713f12;">
                Add New Entry
              </h4>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem;">
                <div>
                  <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                    Label
                  </label>
                  <ct-input
                    $value={labelField}
                    placeholder="Item name"
                    style="width: 100%;"
                  />
                </div>
                <div>
                  <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                    Note
                  </label>
                  <ct-input
                    $value={noteField}
                    placeholder="Optional note"
                    style="width: 100%;"
                  />
                </div>
              </div>
              <ct-button
                onClick={addEntry}
                style="width: 100%; background: #3b82f6; color: white;"
              >
                ➕ Add Entry to Group
              </ct-button>
            </div>

            {/* Update Entry Fields */}
            <div style="border-top: 1px solid #fde047; padding-top: 1rem; margin-top: 1rem;">
              <h4 style="margin: 0 0 0.75rem 0; color: #713f12;">
                Update Entry
              </h4>
              <div style="display: flex; gap: 0.5rem;">
                <ct-button
                  onClick={updateLabel}
                  style="flex: 1; background: #8b5cf6; color: white;"
                >
                  Update Label
                </ct-button>
                <ct-button
                  onClick={updateNote}
                  style="flex: 1; background: #ec4899; color: white;"
                >
                  Update Note
                </ct-button>
              </div>
            </div>
          </ct-card>

          {/* Group Summaries */}
          <ct-card style="background: #f0fdf4; border: 1px solid #86efac;">
            <h3 style="margin: 0 0 1rem 0; color: #166534;">Group Summaries</h3>
            {lift(
              (
                sums:
                  | { title: string; total: number; notes: string[] }[]
                  | undefined,
              ) => {
                if (!sums || !Array.isArray(sums) || sums.length === 0) {
                  return (
                    <div style="padding: 1rem; text-align: center; color: #64748b;">
                      No summaries available
                    </div>
                  );
                }

                const summaryElements = [];
                for (const sum of sums) {
                  const notesCount = sum.notes.filter((n) => n !== "").length;
                  summaryElements.push(
                    <div
                      key={sum.title}
                      style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: white; border-radius: 0.375rem; border: 1px solid #d1fae5;"
                    >
                      <span style="font-weight: 600; color: #1e293b;">
                        {sum.title}
                      </span>
                      <div style="display: flex; gap: 1rem; align-items: center;">
                        <span style="font-family: monospace; color: #64748b;">
                          {String(notesCount)} notes
                        </span>
                        <span style="font-weight: 700; color: #059669; font-family: monospace;">
                          Total: {String(sum.total)}
                        </span>
                      </div>
                    </div>,
                  );
                }

                return (
                  <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    {summaryElements}
                  </div>
                );
              },
            )(summaries)}
          </ct-card>

          {/* All Notes */}
          {lift((notes: string[] | undefined) => {
            const notesList = Array.isArray(notes) ? notes : [];
            if (notesList.length === 0) {
              return null;
            }

            const noteElements = [];
            for (const note of notesList) {
              noteElements.push(
                <div
                  key={note}
                  style="padding: 0.5rem 0.75rem; background: white; border-left: 3px solid #06b6d4; font-size: 0.875rem; color: #334155;"
                >
                  {note}
                </div>,
              );
            }

            return (
              <ct-card style="background: #ecfeff; border: 1px solid #67e8f9;">
                <h3 style="margin: 0 0 0.75rem 0; color: #155e75;">
                  All Notes ({String(notesList.length)})
                </h3>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  {noteElements}
                </div>
              </ct-card>
            );
          })(allNotes)}
        </div>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
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
