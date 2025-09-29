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

interface CanonicalEntryInput {
  id?: string;
  label?: string;
  value?: number;
}

interface CanonicalGroupInput {
  name?: string;
  counters?: CanonicalEntryInput[];
}

interface CanonicalFormArgs {
  groups: Default<CanonicalGroupInput[], []>;
}

interface CanonicalEntry {
  id: string;
  label: string;
  value: number;
}

interface CanonicalGroup {
  name: string;
  counters: CanonicalEntry[];
}

interface CanonicalGroupSummary extends CanonicalGroup {
  total: number;
}

interface CanonicalForm {
  groups: CanonicalGroupSummary[];
  totalValue: number;
  signature: string[];
}

const toInteger = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const sanitizeString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
};

const sanitizeEntry = (
  entry: CanonicalEntryInput | undefined,
  index: number,
  groupName: string,
): CanonicalEntry => {
  const defaultLabel = `Entry ${index + 1}`;
  const label = sanitizeString(entry?.label, defaultLabel);
  const fallbackId = `${groupName}-${index + 1}`;
  const preferredId = entry?.id ?? label;
  const id = sanitizeString(preferredId, fallbackId);
  const value = toInteger(entry?.value, 0);
  return { id, label, value };
};

const sanitizeGroup = (
  group: CanonicalGroupInput | undefined,
  index: number,
): CanonicalGroup => {
  const name = sanitizeString(group?.name, `Group ${index + 1}`);
  const countersInput = Array.isArray(group?.counters)
    ? group?.counters as readonly CanonicalEntryInput[]
    : [];
  const counters = countersInput.map((entry, entryIndex) =>
    sanitizeEntry(entry, entryIndex, name)
  );
  return { name, counters };
};

const sanitizeGroups = (
  groups: readonly CanonicalGroupInput[] | undefined,
): CanonicalGroup[] => {
  if (!Array.isArray(groups)) return [];
  return groups.map((group, index) => sanitizeGroup(group, index));
};

const toInputShape = (groups: CanonicalGroup[]): CanonicalGroupInput[] =>
  groups.map((group) => ({
    name: group.name,
    counters: group.counters.map((entry) => ({
      id: entry.id,
      label: entry.label,
      value: entry.value,
    })),
  }));

const canonicalizeGroups = (groups: CanonicalGroup[]): CanonicalForm => {
  const sortedGroups = groups.map((group) => ({
    name: group.name,
    counters: group.counters.map((entry) => ({ ...entry })),
  }));

  sortedGroups.sort((left, right) =>
    left.name.localeCompare(right.name, "en", { sensitivity: "base" })
  );

  const summaryGroups: CanonicalGroupSummary[] = sortedGroups.map((group) => {
    const counters = [...group.counters].sort((left, right) => {
      const labelCompare = left.label.localeCompare(right.label, "en", {
        sensitivity: "base",
      });
      if (labelCompare !== 0) return labelCompare;
      return left.id.localeCompare(right.id, "en", { sensitivity: "base" });
    });
    const total = counters.reduce((sum, entry) => sum + entry.value, 0);
    return { name: group.name, counters, total };
  });

  const totalValue = summaryGroups.reduce(
    (sum, group) => sum + group.total,
    0,
  );
  const signature = summaryGroups.flatMap((group) =>
    group.counters.map((entry) => `${group.name}:${entry.label}:${entry.value}`)
  );

  return { groups: summaryGroups, totalValue, signature };
};

const sanitizeStringList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.map((value, index) =>
    sanitizeString(value, `record-${index + 1}`)
  );
};

interface AdjustEvent {
  group?: string;
  id?: string;
  label?: string;
  delta?: number;
  set?: number;
}

const applyAdjustment = handler(
  (
    event: AdjustEvent | undefined,
    context: {
      groups: Cell<CanonicalGroupInput[]>;
      history: Cell<string[]>;
      lastMutation: Cell<string>;
      operations: Cell<number>;
    },
  ) => {
    const sanitizedGroups = sanitizeGroups(context.groups.get());

    const groupName = sanitizeString(event?.group, "Unsorted");
    const requestedLabel = event?.label ?? event?.id;
    const label = sanitizeString(requestedLabel, "Unnamed");
    const id = sanitizeString(event?.id ?? label, `${groupName}-${label}`);

    const existingGroup = sanitizedGroups.find((group) =>
      group.name.toLowerCase() === groupName.toLowerCase()
    );

    const targetGroup = existingGroup ?? {
      name: groupName,
      counters: [],
    };

    if (!existingGroup) sanitizedGroups.push(targetGroup);

    const existingEntry = targetGroup.counters.find((entry) =>
      entry.id.toLowerCase() === id.toLowerCase()
    );

    const entry = existingEntry ?? {
      id,
      label,
      value: 0,
    };

    if (!existingEntry) targetGroup.counters.push(entry);

    if (event?.label) {
      entry.label = label;
    }

    entry.id = id;

    if (typeof event?.set === "number" && Number.isFinite(event.set)) {
      entry.value = toInteger(event.set, entry.value);
    } else {
      const delta = toInteger(event?.delta, 1);
      entry.value = toInteger(entry.value + delta, entry.value);
    }

    const normalizedGroups = toInputShape(sanitizedGroups);
    context.groups.set(normalizedGroups);

    const mutationSummary = `${targetGroup.name}:${entry.label}:${entry.value}`;

    const historyRecords = sanitizeStringList(context.history.get());
    historyRecords.push(mutationSummary);
    context.history.set(historyRecords);

    const operations = toInteger(context.operations.get(), 0) + 1;
    context.operations.set(operations);

    context.lastMutation.set(mutationSummary);
  },
);

/** Pattern computing canonical view of nested counters for stable assertions. */
export const counterWithDerivedCanonicalFormUx = recipe<CanonicalFormArgs>(
  "Counter With Derived Canonical Form (UX)",
  ({ groups }) => {
    const history = cell<string[]>([]);
    const lastMutation = cell("none");
    const operations = cell(0);

    // UI-specific cells for form input
    const inputGroup = cell("");
    const inputId = cell("");
    const inputLabel = cell("");
    const inputDelta = cell("1");

    const groupsView = lift((input: CanonicalGroupInput[] | undefined) =>
      sanitizeGroups(input)
    )(groups);

    const canonical = derive(groupsView, canonicalizeGroups);

    const totalValue = derive(canonical, (form) => form.totalValue);
    const signatureList = derive(canonical, (form) => form.signature);

    const signatureText = lift((items: string[] | undefined) => {
      const entries = sanitizeStringList(items);
      return entries.length === 0 ? "none" : entries.join(" | ");
    })(signatureList);

    const historyView = lift((entries: string[] | undefined) =>
      sanitizeStringList(entries)
    )(history);

    const operationsView = lift((count: number | undefined) =>
      Math.max(0, toInteger(count, 0))
    )(operations);

    const lastMutationView = lift((value: string | undefined) =>
      sanitizeString(value, "none")
    )(lastMutation);

    const name = str`Canonical Form Counter (Total: ${totalValue})`;

    // Handler for UI-triggered adjustments
    const adjustFromInputs = handler<
      unknown,
      {
        groups: Cell<CanonicalGroupInput[]>;
        history: Cell<string[]>;
        lastMutation: Cell<string>;
        operations: Cell<number>;
        inputGroup: Cell<string>;
        inputId: Cell<string>;
        inputLabel: Cell<string>;
        inputDelta: Cell<string>;
      }
    >((_event, context) => {
      const sanitizedGroups = sanitizeGroups(context.groups.get());

      const groupName = sanitizeString(
        context.inputGroup.get(),
        "Unsorted",
      );
      const requestedLabel = context.inputLabel.get() || context.inputId.get();
      const label = sanitizeString(requestedLabel, "Unnamed");
      const id = sanitizeString(
        context.inputId.get() || label,
        `${groupName}-${label}`,
      );
      const deltaStr = context.inputDelta.get();
      const delta = toInteger(
        typeof deltaStr === "string" ? parseInt(deltaStr, 10) : deltaStr,
        1,
      );

      const existingGroup = sanitizedGroups.find((group) =>
        group.name.toLowerCase() === groupName.toLowerCase()
      );

      const targetGroup = existingGroup ?? {
        name: groupName,
        counters: [],
      };

      if (!existingGroup) sanitizedGroups.push(targetGroup);

      const existingEntry = targetGroup.counters.find((entry) =>
        entry.id.toLowerCase() === id.toLowerCase()
      );

      const entry = existingEntry ?? {
        id,
        label,
        value: 0,
      };

      if (!existingEntry) targetGroup.counters.push(entry);

      entry.label = label;
      entry.id = id;
      entry.value = toInteger(entry.value + delta, entry.value);

      const normalizedGroups = toInputShape(sanitizedGroups);
      context.groups.set(normalizedGroups);

      const mutationSummary =
        `${targetGroup.name}:${entry.label}:${entry.value}`;

      const historyRecords = sanitizeStringList(context.history.get());
      historyRecords.push(mutationSummary);
      context.history.set(historyRecords);

      const ops = toInteger(context.operations.get(), 0) + 1;
      context.operations.set(ops);

      context.lastMutation.set(mutationSummary);
    })({
      groups,
      history,
      lastMutation,
      operations,
      inputGroup,
      inputId,
      inputLabel,
      inputDelta,
    });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Canonical Form Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Manage nested counter groups with automatic normalization
                </h2>
              </div>

              <div
                style="
                  background: linear-gradient(135deg, #3b82f6, #2563eb);
                  color: white;
                  padding: 1.5rem;
                  border-radius: 0.75rem;
                  text-align: center;
                  font-weight: 600;
                  box-shadow: 0 4px 6px rgba(37, 99, 235, 0.2);
                "
                data-testid="total-display"
              >
                <div style="
                    font-size: 0.875rem;
                    opacity: 0.9;
                    margin-bottom: 0.5rem;
                  ">
                  Total Value
                </div>
                <div style="font-size: 3rem;">{totalValue}</div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 1rem;
                ">
                <div style="
                    background: #f8fafc;
                    padding: 1rem;
                    border-radius: 0.5rem;
                    border: 1px solid #e2e8f0;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      margin-bottom: 0.25rem;
                    ">
                    Operations
                  </div>
                  <div style="
                      font-size: 1.5rem;
                      font-weight: 600;
                      color: #0f172a;
                    ">
                    {operationsView}
                  </div>
                </div>

                <div style="
                    background: #f8fafc;
                    padding: 1rem;
                    border-radius: 0.5rem;
                    border: 1px solid #e2e8f0;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      margin-bottom: 0.25rem;
                    ">
                    Last Mutation
                  </div>
                  <div style="
                      font-size: 0.875rem;
                      font-weight: 500;
                      color: #0f172a;
                      font-family: monospace;
                    ">
                    {lastMutationView}
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Add or Adjust Counter
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 1rem;
                ">
                <div>
                  <label style="
                      display: block;
                      font-size: 0.875rem;
                      font-weight: 500;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Group Name
                  </label>
                  <ct-input
                    $value={inputGroup}
                    placeholder="e.g., Workspace"
                    data-testid="input-group"
                  />
                </div>

                <div>
                  <label style="
                      display: block;
                      font-size: 0.875rem;
                      font-weight: 500;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Entry ID
                  </label>
                  <ct-input
                    $value={inputId}
                    placeholder="e.g., task-counter"
                    data-testid="input-id"
                  />
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 1rem;
                ">
                <div>
                  <label style="
                      display: block;
                      font-size: 0.875rem;
                      font-weight: 500;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Label
                  </label>
                  <ct-input
                    $value={inputLabel}
                    placeholder="e.g., Tasks"
                    data-testid="input-label"
                  />
                </div>

                <div>
                  <label style="
                      display: block;
                      font-size: 0.875rem;
                      font-weight: 500;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Delta
                  </label>
                  <ct-input
                    $value={inputDelta}
                    placeholder="1"
                    data-testid="input-delta"
                  />
                </div>
              </div>

              <ct-button
                onClick={adjustFromInputs}
                data-testid="adjust-button"
              >
                Adjust Counter
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Canonical Groups (Sorted)
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              {lift((form: CanonicalForm) => {
                if (
                  !form || !Array.isArray(form.groups) ||
                  form.groups.length === 0
                ) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 2rem;
                        color: #94a3b8;
                        font-size: 0.875rem;
                      ">
                      No groups yet. Add a counter to get started.
                    </div>
                  );
                }

                const groupElements = form.groups.map((group, groupIndex) => {
                  const groupBg = groupIndex % 2 === 0 ? "#f8fafc" : "#f1f5f9";
                  const groupStyle = "background: " + groupBg +
                    "; padding: 1rem; border-radius: 0.5rem; border: 1px solid #e2e8f0;";
                  const totalLabel = "Total: " + String(group.total);

                  const entryElements = group.counters.map((entry) => {
                    const entryValue = String(entry.value);
                    return (
                      <div
                        key={entry.id}
                        style="
                          background: white;
                          padding: 0.75rem;
                          border-radius: 0.375rem;
                          border: 1px solid #e2e8f0;
                          display: flex;
                          flex-direction: column;
                          gap: 0.25rem;
                        "
                      >
                        <div style="
                            font-size: 0.875rem;
                            font-weight: 600;
                            color: #0f172a;
                          ">
                          {entry.label}
                        </div>
                        <div style="
                            font-size: 0.75rem;
                            color: #64748b;
                            font-family: monospace;
                          ">
                          {entry.id}
                        </div>
                        <div style="
                            font-size: 1.5rem;
                            font-weight: 700;
                            color: #3b82f6;
                          ">
                          {entryValue}
                        </div>
                      </div>
                    );
                  });

                  return (
                    <div key={group.name} style={groupStyle}>
                      <div style="
                          display: flex;
                          justify-content: space-between;
                          align-items: center;
                          margin-bottom: 0.75rem;
                          padding-bottom: 0.5rem;
                          border-bottom: 2px solid #cbd5e1;
                        ">
                        <h4 style="
                            margin: 0;
                            font-size: 1rem;
                            color: #0f172a;
                            font-weight: 600;
                          ">
                          {group.name}
                        </h4>
                        <span style="
                            background: #3b82f6;
                            color: white;
                            padding: 0.25rem 0.75rem;
                            border-radius: 1rem;
                            font-size: 0.875rem;
                            font-weight: 600;
                          ">
                          {totalLabel}
                        </span>
                      </div>

                      <div style="
                          display: grid;
                          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                          gap: 0.75rem;
                        ">
                        {entryElements}
                      </div>
                    </div>
                  );
                });

                return (
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 1rem;
                    ">
                    {groupElements}
                  </div>
                );
              })(canonical)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Canonical Signature
              </h3>
            </div>
            <div
              slot="content"
              style="
                font-family: monospace;
                font-size: 0.75rem;
                color: #475569;
                background: #f8fafc;
                padding: 1rem;
                border-radius: 0.5rem;
                overflow-wrap: break-word;
                line-height: 1.6;
              "
            >
              {signatureText}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                History (Last 10)
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {lift((entries: string[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 1rem;
                        color: #94a3b8;
                        font-size: 0.875rem;
                      ">
                      No mutations yet
                    </div>
                  );
                }

                const recent = entries.slice(-10).reverse();
                return (
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.5rem;
                    ">
                    {recent.map((record, index) => (
                      <div
                        key={index}
                        style="
                          background: #f8fafc;
                          padding: 0.5rem 0.75rem;
                          border-radius: 0.375rem;
                          font-family: monospace;
                          font-size: 0.75rem;
                          color: #475569;
                          border-left: 3px solid #3b82f6;
                        "
                      >
                        {record}
                      </div>
                    ))}
                  </div>
                );
              })(historyView)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Pattern Explanation
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                font-size: 0.9rem;
                color: #475569;
                line-height: 1.6;
              "
            >
              <p style="margin: 0;">
                This pattern demonstrates{" "}
                <strong>canonical form derivation</strong>{" "}
                from nested counter groups. It automatically normalizes and
                sorts groups and entries alphabetically, computing stable
                signatures for testing and comparison.
              </p>
              <p style="margin: 0;">
                When you adjust counters, the system creates or updates entries
                within their groups, then derives a canonical view that sorts
                everything consistently. The signature provides a deterministic
                string representation of the entire state.
              </p>
              <p style="margin: 0;">
                This pattern is useful for scenarios where you need stable,
                sorted representations of hierarchical data—like configuration
                managers, inventory systems, or any domain where canonical
                comparison matters.
              </p>
            </div>
          </ct-card>
        </div>
      ),
      groups: groupsView,
      canonical,
      totalValue,
      signatureText,
      operations: operationsView,
      lastMutation: lastMutationView,
      history: historyView,
      controls: {
        adjust: applyAdjustment({
          groups,
          history,
          lastMutation,
          operations,
        }),
        adjustFromInputs,
      },
    };
  },
);

export default counterWithDerivedCanonicalFormUx;
