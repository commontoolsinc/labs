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

interface DeduplicatedListArgs {
  value: Default<number, 0>;
  uniqueValues: Default<number[], []>;
}

interface DedupAudit {
  added: number;
  skipped: number;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const sanitizeNumberList = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const item of input) {
    sanitized.push(toInteger(item));
  }
  return sanitized;
};

const uniqueInOrder = (values: readonly number[]): number[] => {
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
};

const sortAscending = (values: readonly number[]): number[] => {
  return [...values].sort((left, right) => left - right);
};

export const counterWithDeduplicatedListUx = recipe<DeduplicatedListArgs>(
  "Counter With Deduplicated List (UX)",
  ({ value, uniqueValues }) => {
    const additions = cell(0);
    const duplicates = cell(0);
    const audit = cell<DedupAudit>({ added: 0, skipped: 0 });

    const uniqueValuesView = lift((entries: number[] | undefined) =>
      uniqueInOrder(sanitizeNumberList(entries))
    )(uniqueValues);
    const sortedUnique = derive(uniqueValuesView, sortAscending);
    const sortedLabel = lift((entries: number[] | undefined) => {
      const values = Array.isArray(entries) ? entries : [];
      return values.length === 0 ? "none" : values.join(", ");
    })(sortedUnique);
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const additionsView = lift((count: number | undefined) =>
      Math.max(0, toInteger(count))
    )(additions);
    const duplicatesView = lift((count: number | undefined) =>
      Math.max(0, toInteger(count))
    )(duplicates);
    const auditView = lift((record: DedupAudit | undefined) =>
      record ?? { added: 0, skipped: 0 }
    )(audit);

    const amountField = cell<string>("1");
    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.trunc(parsed);
      return normalized === 0 ? 1 : normalized;
    });

    const add = handler<
      unknown,
      {
        value: Cell<number>;
        uniqueValues: Cell<number[]>;
        additions: Cell<number>;
        duplicates: Cell<number>;
        audit: Cell<DedupAudit>;
        amount: Cell<number>;
      }
    >((_event, context) => {
      const amount = toInteger(context.amount.get());
      const currentValue = toInteger(context.value.get());
      const nextValue = currentValue + amount;
      context.value.set(nextValue);

      const existing = sanitizeNumberList(context.uniqueValues.get());
      const unique = uniqueInOrder(existing);

      if (!unique.includes(nextValue)) {
        unique.push(nextValue);
        context.uniqueValues.set(unique);
        const recorded = toInteger(context.additions.get());
        context.additions.set(recorded + 1);
      } else {
        const skipped = toInteger(context.duplicates.get());
        context.duplicates.set(skipped + 1);
      }

      const added = toInteger(context.additions.get());
      const skipped = toInteger(context.duplicates.get());
      const auditRecord: DedupAudit = { added, skipped };
      context.audit.set(auditRecord);
    })({
      value,
      uniqueValues,
      additions,
      duplicates,
      audit,
      amount: amountMagnitude,
    });

    const syncAmountField = compute(() => {
      const text = `${amountMagnitude.get()}`;
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const currentDisplay = derive(currentValue, (v) => `${v}`);
    const name = str`Deduplicated list tracker (${currentDisplay})`;

    const uniqueCount = lift((values: number[] | undefined) =>
      Array.isArray(values) ? values.length : 0
    )(uniqueValuesView);

    const statusText = lift(
      ({ added, skipped }: { added: number; skipped: number }) =>
        `${added} unique value${
          added === 1 ? "" : "s"
        } added • ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`,
    )({ added: additionsView, skipped: duplicatesView });

    const renderedList = lift((values: number[] | undefined) => {
      const items = Array.isArray(values) ? values : [];
      if (items.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #94a3b8;
              font-style: italic;
            ">
            No unique values yet
          </div>
        );
      }
      return (
        <div style="
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
          ">
          {items.map((val) => (
            <div
              key={val}
              style="
                background: linear-gradient(135deg, #3b82f6, #2563eb);
                color: white;
                padding: 0.5rem 0.75rem;
                border-radius: 0.5rem;
                font-weight: 600;
                font-size: 0.9rem;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
              "
            >
              {val}
            </div>
          ))}
        </div>
      );
    })(sortedUnique);

    const progressPercent = lift(
      ({ added, skipped }: { added: number; skipped: number }) => {
        const total = added + skipped;
        if (total === 0) return 0;
        return Math.round((added / total) * 100);
      },
    )({ added: additionsView, skipped: duplicatesView });

    const progressStyle = lift((percent: number) => `
      width: ${percent}%;
      height: 100%;
      background: linear-gradient(90deg, #22c55e, #16a34a);
      border-radius: 0.25rem;
      transition: width 0.3s ease;
    `)(progressPercent);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
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
                  Deduplication pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with deduplicated value tracking
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Increments a counter and records only unique values in
                  history. Duplicate values are tracked but not added to the
                  list.
                </p>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #f8fafc, #e2e8f0);
                    border: 2px solid #cbd5e1;
                    border-radius: 1rem;
                    padding: 1.5rem;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                  ">
                  <div style="
                      font-size: 0.8rem;
                      font-weight: 600;
                      color: #475569;
                      letter-spacing: 0.05em;
                      text-transform: uppercase;
                    ">
                    Current value
                  </div>
                  <div style="
                      font-size: 3.5rem;
                      font-weight: 700;
                      color: #0f172a;
                      line-height: 1;
                    ">
                    {currentDisplay}
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                  ">
                  <div style="
                      background: #dcfce7;
                      border: 1px solid #86efac;
                      border-radius: 0.75rem;
                      padding: 1rem;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      gap: 0.25rem;
                    ">
                    <div style="
                        font-size: 2rem;
                        font-weight: 700;
                        color: #166534;
                      ">
                      {additionsView}
                    </div>
                    <div style="
                        font-size: 0.75rem;
                        font-weight: 600;
                        color: #166534;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Unique
                    </div>
                  </div>
                  <div style="
                      background: #fef3c7;
                      border: 1px solid #fde68a;
                      border-radius: 0.75rem;
                      padding: 1rem;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      gap: 0.25rem;
                    ">
                    <div style="
                        font-size: 2rem;
                        font-weight: 700;
                        color: #92400e;
                      ">
                      {duplicatesView}
                    </div>
                    <div style="
                        font-size: 0.75rem;
                        font-weight: 600;
                        color: #92400e;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Duplicates
                    </div>
                  </div>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="increment-amount"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Increment amount
                  </label>
                  <ct-input
                    id="increment-amount"
                    type="number"
                    step="1"
                    $value={amountField}
                    aria-label="Amount to increment counter"
                  >
                  </ct-input>
                </div>
                <ct-button onClick={add} style="width: 100%;">
                  Add {amountMagnitude} to counter
                </ct-button>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: #334155;
                  ">
                  Deduplication progress
                </div>
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.5rem;
                    height: 1.5rem;
                    overflow: hidden;
                  ">
                  <div style={progressStyle}></div>
                </div>
                <div style="
                    font-size: 0.75rem;
                    color: #64748b;
                    text-align: center;
                  ">
                  {progressPercent}% unique values
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Unique values ({uniqueCount})
              </h3>
              <div style="font-size: 0.85rem; color: #64748b;">
                Sorted in ascending order
              </div>
            </div>
            <div slot="content">
              {renderedList}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569; text-align: center;"
          >
            {statusText}
          </div>
        </div>
      ),
      value,
      currentValue,
      uniqueValues: uniqueValuesView,
      sortedUnique,
      uniqueLabel: str`Unique values: ${sortedLabel}`,
      additions: additionsView,
      duplicates: duplicatesView,
      audit: auditView,
      amountField,
      amountMagnitude,
      currentDisplay,
      name,
      uniqueCount,
      statusText,
      effects: {
        syncAmountField,
      },
      controls: {
        add,
      },
    };
  },
);

export default counterWithDeduplicatedListUx;
