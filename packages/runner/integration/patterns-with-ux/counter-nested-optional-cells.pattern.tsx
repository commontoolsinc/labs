/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
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

interface OptionalBranch {
  counter?: number;
  history?: number[];
  label?: string;
}

interface OptionalNested {
  branch?: OptionalBranch;
}

interface NestedOptionalState {
  nested?: OptionalNested;
}

interface NestedOptionalArgs {
  state: Default<NestedOptionalState, {}>;
}

interface IncrementEvent {
  amount?: number;
  label?: string;
}

interface ClearEvent {
  target?: "branch" | "nested";
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getNested = (
  value: NestedOptionalState | undefined,
): OptionalNested | undefined => {
  const nested = value?.nested;
  return isRecord(nested) ? nested as OptionalNested : undefined;
};

const getBranch = (
  nested: OptionalNested | undefined,
): OptionalBranch | undefined => {
  if (!nested) return undefined;
  const branch = nested.branch;
  return isRecord(branch) ? branch as OptionalBranch : undefined;
};

const normalizeHistory = (history: unknown): number[] => {
  if (!Array.isArray(history)) return [];
  return history.filter((entry): entry is number => typeof entry === "number");
};

const sanitizeLabel = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, 60);
};

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const applyIncrementToState = (
  stateCell: Cell<NestedOptionalState>,
  amount: number,
  label: string | undefined,
) => {
  const currentState = stateCell.get() ?? {};
  const nested = getNested(currentState);
  const branch = getBranch(nested);

  const baseCounter = typeof branch?.counter === "number" ? branch.counter : 0;
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const nextCounter = baseCounter + safeAmount;
  const baseHistory = normalizeHistory(branch?.history);

  let nextLabel = typeof branch?.label === "string" ? branch.label : undefined;
  if (typeof label === "string") {
    nextLabel = label.length > 0 ? label : undefined;
  }

  const nextBranch: OptionalBranch = {
    counter: nextCounter,
    history: [...baseHistory, nextCounter],
  };
  if (nextLabel !== undefined) {
    nextBranch.label = nextLabel;
  }

  stateCell.set({ nested: { branch: nextBranch } });
};

const clearBranchState = (stateCell: Cell<NestedOptionalState>) => {
  stateCell.set({ nested: {} });
};

const clearNestedTree = (stateCell: Cell<NestedOptionalState>) => {
  stateCell.set({});
};

const updateNestedState = handler(
  (
    event: IncrementEvent | undefined,
    context: { state: Cell<NestedOptionalState> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    let nextLabel: string | undefined;
    if (typeof event?.label === "string") {
      const trimmed = event.label.trim();
      nextLabel = trimmed.length > 0 ? trimmed : undefined;
    }

    applyIncrementToState(context.state, amount, nextLabel);
  },
);

const clearNestedState = handler(
  (
    event: ClearEvent | undefined,
    context: { state: Cell<NestedOptionalState> },
  ) => {
    if (event?.target === "nested") {
      clearNestedTree(context.state);
      return;
    }
    clearBranchState(context.state);
  },
);

export const counterNestedOptionalCellsUx = recipe<NestedOptionalArgs>(
  "Counter With Nested Optional Cells (UX)",
  ({ state }) => {
    const current = lift((value: NestedOptionalState | undefined) => {
      const branch = getBranch(getNested(value));
      return typeof branch?.counter === "number" ? branch.counter : 0;
    })(state);

    const history = lift((value: NestedOptionalState | undefined) => {
      const branch = getBranch(getNested(value));
      return normalizeHistory(branch?.history);
    })(state);

    const branchTitle = lift((value: NestedOptionalState | undefined) => {
      const branch = getBranch(getNested(value));
      const label = branch?.label;
      if (typeof label === "string" && label.length > 0) {
        return label;
      }
      return "Unnamed branch";
    })(state);

    const hasNested = lift((value: NestedOptionalState | undefined) =>
      getNested(value) !== undefined
    )(state);

    const hasBranch = lift((value: NestedOptionalState | undefined) =>
      getBranch(getNested(value)) !== undefined
    )(state);

    const nestedIndicator = lift((present: boolean) =>
      present ? "present" : "missing"
    )(hasNested);

    const branchIndicator = lift((present: boolean) =>
      present ? "present" : "missing"
    )(hasBranch);

    const status =
      str`Count ${current} (nested:${nestedIndicator} branch:${branchIndicator})`;

    const label = str`${branchTitle} ${current}`;

    const currentDisplay = derive(current, (value) => formatNumber(value));

    const historyEntries = derive(
      history,
      (entries) =>
        entries.map((value, index) => ({
          id: `${index}-${value}`,
          position: index + 1,
          label: formatNumber(value),
        })),
    );

    const historyCount = derive(history, (entries) => entries.length);

    const historyBadges = lift((info: {
      items: { id: string; label: string; position: number }[];
    }) => {
      if (info.items.length === 0) {
        return [
          <span
            key="empty"
            style="
              color: #64748b;
              font-size: 0.85rem;
            "
          >
            No history recorded yet.
          </span>,
        ];
      }
      return info.items.map((entry) => (
        <ct-badge
          key={entry.id}
          data-testid={`history-entry-${entry.position - 1}`}
          variant="subtle"
        >
          #{entry.position}: {entry.label}
        </ct-badge>
      ));
    })({ items: historyEntries });

    const presenceBadges = lift((details: {
      nested: string;
      branch: string;
    }) => [
      <ct-badge
        key="nested"
        variant="outline"
      >
        Nested cell {details.nested}
      </ct-badge>,
      <ct-badge
        key="branch"
        variant="outline"
      >
        Branch cell {details.branch}
      </ct-badge>,
    ])({
      nested: nestedIndicator,
      branch: branchIndicator,
    });

    const amountField = cell<string>("1");
    const amountValue = derive(amountField, (raw) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 1;
      const limited = Math.max(Math.min(parsed, 9999), -9999);
      return Math.round(limited * 100) / 100;
    });
    const amountDisplay = derive(amountValue, (value) => formatNumber(value));

    const labelField = cell<string>("");
    const labelValue = derive(labelField, (raw) => sanitizeLabel(raw));

    const previewLabel = lift((info: { label: string; fallback: string }) =>
      info.label.length > 0 ? info.label : info.fallback
    )({ label: labelValue, fallback: branchTitle });

    const incrementCustom = handler<
      unknown,
      {
        amount: Cell<number>;
        label: Cell<string>;
        amountField: Cell<string>;
        labelField: Cell<string>;
        state: Cell<NestedOptionalState>;
      }
    >((_event, context) => {
      const amount = context.amount.get();
      const labelText = context.label.get();
      applyIncrementToState(
        context.state,
        amount,
        labelText.length > 0 ? labelText : undefined,
      );
      context.amountField.set(formatNumber(amount));
      context.labelField.set(labelText);
    });

    const quickIncrement = (delta: number) =>
      handler<
        unknown,
        {
          state: Cell<NestedOptionalState>;
          label: Cell<string>;
          labelField: Cell<string>;
        }
      >((_event, context) => {
        const labelText = context.label.get();
        applyIncrementToState(
          context.state,
          delta,
          labelText.length > 0 ? labelText : undefined,
        );
        context.labelField.set(labelText);
      });

    const clearBranch = handler<
      unknown,
      { state: Cell<NestedOptionalState> }
    >((_event, context) => {
      clearBranchState(context.state);
    });

    const clearNested = handler<
      unknown,
      { state: Cell<NestedOptionalState> }
    >((_event, context) => {
      clearNestedTree(context.state);
    });

    const quickPlusOne = quickIncrement(1)({
      state,
      label: labelValue,
      labelField,
    });
    const quickPlusFive = quickIncrement(5)({
      state,
      label: labelValue,
      labelField,
    });
    const quickMinusOne = quickIncrement(-1)({
      state,
      label: labelValue,
      labelField,
    });

    const applyIncrement = incrementCustom({
      amount: amountValue,
      label: labelValue,
      amountField,
      labelField,
      state,
    });

    const clearBranchAction = clearBranch({ state });
    const clearNestedAction = clearNested({ state });

    const name = str`${branchTitle} • count ${currentDisplay}`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 32rem;
          ">
          <ct-card>
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
                  gap: 1rem;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      letter-spacing: 0.08em;
                      text-transform: uppercase;
                      color: #64748b;
                    ">
                    Branch title
                  </span>
                  <strong
                    data-testid="branch-title"
                    style="
                      font-size: 1.1rem;
                      color: #0f172a;
                    "
                  >
                    {branchTitle}
                  </strong>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      letter-spacing: 0.08em;
                      text-transform: uppercase;
                      color: #64748b;
                    ">
                    Current count
                  </span>
                  <strong
                    data-testid="current-count"
                    style="
                      font-size: 1.75rem;
                      color: #0f172a;
                    "
                  >
                    {currentDisplay}
                  </strong>
                </div>
              </div>
              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <span style="
                    font-size: 0.8rem;
                    color: #334155;
                  ">
                  Structure
                </span>
                {presenceBadges}
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.6rem;
                ">
                <span style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #1e293b;
                  ">
                  Increment branch
                </span>
                <div style="
                    display: grid;
                    gap: 0.75rem;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                  ">
                  <ct-input
                    data-testid="amount-input"
                    type="number"
                    step="0.01"
                    $value={amountField}
                    aria-label="Increment amount"
                  >
                    <span slot="label">Amount</span>
                  </ct-input>
                  <ct-input
                    data-testid="label-input"
                    $value={labelField}
                    aria-label="Optional label"
                  >
                    <span slot="label">Label (optional)</span>
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button
                    data-testid="apply-increment"
                    onClick={applyIncrement}
                  >
                    Apply {amountDisplay}
                  </ct-button>
                  <ct-button
                    data-testid="increment-plus-one"
                    variant="secondary"
                    onClick={quickPlusOne}
                  >
                    +1
                  </ct-button>
                  <ct-button
                    data-testid="increment-plus-five"
                    variant="secondary"
                    onClick={quickPlusFive}
                  >
                    +5
                  </ct-button>
                  <ct-button
                    data-testid="increment-minus-one"
                    variant="secondary"
                    onClick={quickMinusOne}
                  >
                    -1
                  </ct-button>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    font-size: 0.8rem;
                    color: #475569;
                  ">
                  <span data-testid="preview-label">
                    Next label: {previewLabel}
                  </span>
                  <span>
                    Applying updates adds to history and creates nested cells
                    when missing.
                  </span>
                </div>
              </div>
              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  data-testid="clear-branch"
                  variant="ghost"
                  onClick={clearBranchAction}
                >
                  Clear branch values
                </ct-button>
                <ct-button
                  data-testid="clear-nested"
                  variant="ghost"
                  onClick={clearNestedAction}
                >
                  Reset nested structure
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                ">
                <span style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #1e293b;
                  ">
                  History
                </span>
                <span style="
                    font-size: 0.8rem;
                    color: #64748b;
                  ">
                  {historyCount} entries
                </span>
              </div>
              <div
                data-testid="history-list"
                style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.5rem;
                "
              >
                {historyBadges}
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="
              font-size: 0.9rem;
              color: #334155;
            "
          >
            {status}
          </div>
        </div>
      ),
      state,
      current,
      history,
      branchTitle,
      label,
      status,
      hasNested,
      hasBranch,
      increment: updateNestedState({ state }),
      clear: clearNestedState({ state }),
      controls: {
        applyIncrement,
        quickPlusOne,
        quickPlusFive,
        quickMinusOne,
        clearBranchAction,
        clearNestedAction,
      },
      inputs: {
        amountField,
        labelField,
      },
      displays: {
        currentDisplay,
        previewLabel,
        presenceBadges,
        historyBadges,
        historyCount,
      },
    };
  },
);

export default counterNestedOptionalCellsUx;
