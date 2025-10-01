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

interface KeyedMapArgs {
  counters: Default<Record<string, number>, { [key: string]: number }>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const sanitizeKey = (input: unknown): string => {
  if (typeof input !== "string") return "default";
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : "default";
};

const resolveAmount = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 1;
  }
  return Math.trunc(input);
};

const adjustKeyedCounter = handler(
  (
    event: { key?: string; amount?: number } | undefined,
    context: { counters: Cell<Record<string, number>> },
  ) => {
    const key = sanitizeKey(event?.key);
    const amount = resolveAmount(event?.amount);
    const entry = context.counters.key(key) as Cell<number>;
    const current = entry.get() ?? 0;
    entry.set(current + amount);
  },
);

const removeKey = handler(
  (
    event: { key?: string } | undefined,
    context: { counters: Cell<Record<string, number>> },
  ) => {
    const key = sanitizeKey(event?.key);
    const map = context.counters.get() ?? {};
    const updated = { ...map };
    delete updated[key];
    context.counters.set(updated);
  },
);

const resetCounters = handler(
  (_event: unknown, context: { counters: Cell<Record<string, number>> }) => {
    context.counters.set({});
  },
);

export const counterKeyedMapUx = recipe<KeyedMapArgs>(
  "Counter Keyed Map (UX)",
  ({ counters }) => {
    const keys = lift((map: Record<string, number> | undefined) =>
      map ? Object.keys(map).sort() : []
    )(
      counters,
    );
    const total = lift((map: Record<string, number> | undefined) =>
      map ? Object.values(map).reduce((sum, value) => sum + value, 0) : 0
    )(counters);
    const count = lift((map: Record<string, number> | undefined) =>
      map ? Object.keys(map).length : 0
    )(counters);
    const summary = str`${count} keys total ${total}`;

    const keyField = cell<string>("");
    const amountField = cell<string>("1");
    const targetKeyField = cell<string>("");

    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return Math.trunc(parsed) || 1;
    });

    const addKey = handler<
      unknown,
      {
        keyInput: Cell<string>;
        amountInput: Cell<number>;
        counters: Cell<Record<string, number>>;
      }
    >((_event, { keyInput, amountInput, counters }) => {
      const key = sanitizeKey(keyInput.get());
      const amount = resolveAmount(amountInput.get());
      const map = counters.get() ?? {};
      const current = map[key] ?? 0;
      counters.set({ ...map, [key]: current + amount });
      keyInput.set("");
    })({ keyInput: keyField, amountInput: amountMagnitude, counters });

    const incrementByKey = handler<
      unknown,
      {
        targetKey: Cell<string>;
        amountInput: Cell<number>;
        counters: Cell<Record<string, number>>;
      }
    >((_event, { targetKey, amountInput, counters }) => {
      const key = sanitizeKey(targetKey.get());
      const amount = Math.abs(resolveAmount(amountInput.get()));
      const map = counters.get() ?? {};
      const current = map[key] ?? 0;
      counters.set({ ...map, [key]: current + amount });
    })({ targetKey: targetKeyField, amountInput: amountMagnitude, counters });

    const decrementByKey = handler<
      unknown,
      {
        targetKey: Cell<string>;
        amountInput: Cell<number>;
        counters: Cell<Record<string, number>>;
      }
    >((_event, { targetKey, amountInput, counters }) => {
      const key = sanitizeKey(targetKey.get());
      const amount = Math.abs(resolveAmount(amountInput.get()));
      const map = counters.get() ?? {};
      const current = map[key] ?? 0;
      counters.set({ ...map, [key]: current - amount });
    })({ targetKey: targetKeyField, amountInput: amountMagnitude, counters });

    const removeKeyHandler = handler<
      unknown,
      {
        targetKey: Cell<string>;
        counters: Cell<Record<string, number>>;
      }
    >((_event, { targetKey, counters }) => {
      const key = sanitizeKey(targetKey.get());
      const map = counters.get() ?? {};
      const updated = { ...map };
      delete updated[key];
      counters.set(updated);
    })({ targetKey: targetKeyField, counters });

    const resetHandler = handler<
      unknown,
      { counters: Cell<Record<string, number>> }
    >((_event, { counters }) => {
      counters.set({});
    })({ counters });

    const setTargetKey = handler<
      { key?: string } | undefined,
      { targetKey: Cell<string> }
    >((event, { targetKey }) => {
      const key = sanitizeKey(event?.key);
      targetKey.set(key);
    })({ targetKey: targetKeyField });

    const incrementTarget = handler<
      { key?: string } | undefined,
      {
        targetKey: Cell<string>;
        amountInput: Cell<number>;
        counters: Cell<Record<string, number>>;
      }
    >((event, { targetKey, amountInput, counters }) => {
      const key = sanitizeKey(event?.key ?? targetKey.get());
      targetKey.set(key);
      const amount = Math.abs(resolveAmount(amountInput.get()));
      const map = counters.get() ?? {};
      const current = map[key] ?? 0;
      counters.set({ ...map, [key]: current + amount });
    })({ targetKey: targetKeyField, amountInput: amountMagnitude, counters });

    const decrementTarget = handler<
      { key?: string } | undefined,
      {
        targetKey: Cell<string>;
        amountInput: Cell<number>;
        counters: Cell<Record<string, number>>;
      }
    >((event, { targetKey, amountInput, counters }) => {
      const key = sanitizeKey(event?.key ?? targetKey.get());
      targetKey.set(key);
      const amount = Math.abs(resolveAmount(amountInput.get()));
      const map = counters.get() ?? {};
      const current = map[key] ?? 0;
      counters.set({ ...map, [key]: current - amount });
    })({ targetKey: targetKeyField, amountInput: amountMagnitude, counters });

    const removeTarget = handler<
      { key?: string } | undefined,
      { targetKey: Cell<string>; counters: Cell<Record<string, number>> }
    >((event, { targetKey, counters }) => {
      const key = sanitizeKey(event?.key ?? targetKey.get());
      targetKey.set(key);
      const map = counters.get() ?? {};
      const updated = { ...map };
      delete updated[key];
      counters.set(updated);
    })({ targetKey: targetKeyField, counters });

    const isEmpty = lift((keyCount: number) => keyCount === 0)(count);
    const hasKeys = lift((keyCount: number) => keyCount > 0)(count);

    const name = str`Counter map (${count} keys)`;

    const syncAmountField = compute(() => {
      const magnitude = amountMagnitude.get();
      const text = `${toInteger(magnitude, 1)}`;
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const countersEntries = lift((map: Record<string, number> | undefined) => {
      if (!map) return [];
      const sortedKeys = Object.keys(map).sort();
      return sortedKeys;
    })(counters);

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
                  Counter Map
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Manage multiple counters by key
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  color: white;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.85rem; opacity: 0.9;">
                    Total across all keys
                  </span>
                  <strong style="font-size: 2.5rem;">
                    {total}
                  </strong>
                </div>
                <div style="
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.9rem;
                    opacity: 0.85;
                  ">
                  <span>
                    {count}{" "}
                    {lift((c: number) => c === 1 ? "key" : "keys")(count)}
                  </span>
                  <span>{summary}</span>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 0.5rem;
                    align-items: end;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="key-input"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Key name
                    </label>
                    <ct-input
                      id="key-input"
                      type="text"
                      placeholder="e.g., apples, tasks, points"
                      $value={keyField}
                      aria-label="Enter a key name"
                    >
                    </ct-input>
                  </div>
                  <ct-button
                    onClick={addKey}
                    aria-label="Add or increment key"
                  >
                    Add +{amountMagnitude}
                  </ct-button>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="amount-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Adjustment amount
                  </label>
                  <ct-input
                    id="amount-input"
                    type="number"
                    step="1"
                    $value={amountField}
                    aria-label="Choose adjustment amount"
                  >
                  </ct-input>
                </div>
              </div>
            </div>
          </ct-card>

          {lift((isEmpty: boolean) =>
            isEmpty
              ? (
                <ct-card>
                  <div
                    slot="content"
                    style="
                      text-align: center;
                      padding: 2rem 1rem;
                      color: #64748b;
                    "
                  >
                    <div style="
                        font-size: 3rem;
                        margin-bottom: 0.5rem;
                      ">
                      📊
                    </div>
                    <p style="margin: 0; font-size: 0.95rem;">
                      No counters yet. Enter a key name above to get started.
                    </p>
                  </div>
                </ct-card>
              )
              : null
          )(isEmpty)}

          {lift((
            { hasKeys, map, keys }: {
              hasKeys: boolean;
              map: Record<string, number> | undefined;
              keys: string[];
            },
          ) =>
            hasKeys && map
              ? (
                <ct-card>
                  <div
                    slot="header"
                    style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    "
                  >
                    <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                      Active counters
                    </h3>
                    <ct-button
                      variant="secondary"
                      onClick={resetHandler}
                      aria-label="Reset all counters"
                    >
                      Reset all
                    </ct-button>
                  </div>
                  <div
                    slot="content"
                    style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.75rem;
                    "
                  >
                    {keys.map((key) => {
                      const value = toInteger(map[key]);
                      return (
                        <div
                          style="
                            background: #f8fafc;
                            border-radius: 0.5rem;
                            padding: 0.75rem 1rem;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            gap: 0.75rem;
                          "
                          data-key={key}
                        >
                          <div style="
                              display: flex;
                              flex-direction: column;
                              gap: 0.1rem;
                              flex: 1;
                            ">
                            <span style="
                                font-weight: 600;
                                color: #0f172a;
                                font-size: 0.95rem;
                              ">
                              {key}
                            </span>
                            <span style="
                                font-size: 1.5rem;
                                color: #667eea;
                                font-weight: 700;
                              ">
                              {value}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ct-card>
              )
              : null
          )({ hasKeys, map: counters, keys: countersEntries })}

          {lift((hasKeys: boolean) =>
            hasKeys
              ? (
                <ct-card>
                  <div
                    slot="header"
                    style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    "
                  >
                    <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                      Modify counters
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
                        display: flex;
                        flex-direction: column;
                        gap: 0.4rem;
                      ">
                      <label
                        for="target-key"
                        style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                        "
                      >
                        Select key to modify
                      </label>
                      <ct-input
                        id="target-key"
                        type="text"
                        placeholder="Enter key name"
                        $value={targetKeyField}
                        aria-label="Select key to modify"
                      >
                      </ct-input>
                    </div>
                    <div style="
                        display: grid;
                        grid-template-columns: repeat(3, minmax(0, 1fr));
                        gap: 0.5rem;
                      ">
                      <ct-button
                        onClick={incrementByKey}
                        aria-label="Increment selected key"
                      >
                        + Increment
                      </ct-button>
                      <ct-button
                        variant="secondary"
                        onClick={decrementByKey}
                        aria-label="Decrement selected key"
                      >
                        - Decrement
                      </ct-button>
                      <ct-button
                        variant="secondary"
                        onClick={removeKeyHandler}
                        aria-label="Remove selected key"
                      >
                        × Remove
                      </ct-button>
                    </div>
                  </div>
                </ct-card>
              )
              : null
          )(hasKeys)}

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      counters,
      keys,
      count,
      total,
      summary,
      adjust: adjustKeyedCounter({ counters }),
      keyField,
      amountField,
      amountMagnitude,
      isEmpty,
      hasKeys,
      countersEntries,
      effects: {
        syncAmountField,
      },
      controls: {
        addKey,
        incrementByKey,
        decrementByKey,
        removeKeyHandler,
        resetHandler,
        setTargetKey,
        incrementTarget,
        decrementTarget,
        removeTarget,
      },
    };
  },
);

export default counterKeyedMapUx;
