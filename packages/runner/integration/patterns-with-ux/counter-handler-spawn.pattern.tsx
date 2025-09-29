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
  toSchema,
  UI,
} from "commontools";

const childIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const spawnedChild = recipe<{ value: Default<number, 0> }, SpawnedChildState>(
  "Spawned Child Counter",
  ({ value }) => {
    return {
      value,
      label: str`Child value ${value}`,
      increment: childIncrement({ value }),
    };
  },
);

type SpawnedChildState = {
  value: number;
  label: string;
  increment: { amount?: number };
};

interface HandlerSpawnArgs {
  children: Default<SpawnedChildState[], []>;
}

const addChild = lift(
  toSchema<
    {
      child: Cell<number>;
      children: Cell<SpawnedChildState[]>;
      initialized: Cell<boolean>;
    }
  >(),
  toSchema<never>(),
  ({ child, children, initialized }) => {
    if (!initialized.get()) {
      children.push(child);
      initialized.set(true);
    }
  },
);

const spawnChild = handler(
  (
    event: { seed?: number },
    context: { children: Cell<SpawnedChildState[]> },
  ) => {
    const seed = typeof event?.seed === "number" ? event.seed : 0;
    const child = spawnedChild({ value: seed });
    return addChild({
      child,
      children: context.children,
      initialized: cell(false),
    });
  },
);

const incrementChild = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: {
      children: Cell<SpawnedChildState[]>;
    },
  ) => {
    const list = context.children.get();
    if (!Array.isArray(list)) return;

    const index = typeof event?.index === "number" ? event.index : -1;
    if (index < 0 || index >= list.length) return;

    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const childCell = context.children.key(index) as Cell<SpawnedChildState>;
    const childState = childCell.get();

    if (childState && typeof childState === "object" && "value" in childState) {
      const valueCell = (childCell as any).key("value") as Cell<number>;
      const currentValue = valueCell.get() ?? 0;
      valueCell.set(currentValue + amount);
    }
  },
);

export const counterWithHandlerSpawnUx = recipe<HandlerSpawnArgs>(
  "Counter With Handler Spawn (UX)",
  ({ children }) => {
    const seedField = cell<string>("0");
    const incrementIndexField = cell<string>("0");
    const incrementAmountField = cell<string>("1");

    const childrenView = lift((entries: SpawnedChildState[] | undefined) => {
      return Array.isArray(entries) ? entries : [];
    })(children);

    const childCount = derive(childrenView, (entries) => entries.length);

    const spawn = handler<
      unknown,
      {
        children: Cell<SpawnedChildState[]>;
        seedField: Cell<string>;
      }
    >((_event, context) => {
      const text = context.seedField.get();
      const parsed = Number(text);
      const seed = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;

      const child = spawnedChild({ value: seed });
      return addChild({
        child,
        children: context.children,
        initialized: cell(false),
      });
    })({ children, seedField });

    const incrementFromFields = handler<
      unknown,
      {
        children: Cell<SpawnedChildState[]>;
        incrementIndexField: Cell<string>;
        incrementAmountField: Cell<string>;
      }
    >((_event, context) => {
      const indexText = context.incrementIndexField.get();
      const amountText = context.incrementAmountField.get();

      const parsedIndex = Number(indexText);
      const parsedAmount = Number(amountText);

      const list = context.children.get();
      if (!Array.isArray(list)) return;

      const index = Number.isFinite(parsedIndex) ? Math.trunc(parsedIndex) : -1;
      if (index < 0 || index >= list.length) return;

      const amount = Number.isFinite(parsedAmount)
        ? Math.trunc(parsedAmount)
        : 1;

      const childCell = context.children.key(index) as Cell<SpawnedChildState>;
      const childState = childCell.get();

      if (
        childState && typeof childState === "object" && "value" in childState
      ) {
        const valueCell = (childCell as any).key("value") as Cell<number>;
        const currentValue = valueCell.get() ?? 0;
        valueCell.set(currentValue + amount);
      }
    })({ children, incrementIndexField, incrementAmountField });

    const name = str`Handler Spawn (${childCount} children)`;

    const childrenUi = lift((entries: SpawnedChildState[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No child counters yet. Spawn one to get started.
          </div>
        );
      }

      const items = entries.map((child, idx) => {
        const value = typeof child?.value === "number" ? child.value : 0;
        const label = typeof child?.label === "string"
          ? child.label
          : "Child " + String(idx);

        const bgColor = "#f0fdf4";
        const borderColor = "#22c55e";
        const textColor = "#15803d";

        return (
          <div
            key={String(idx)}
            style={"background: " + bgColor +
              "; border: 2px solid " + borderColor +
              "; border-radius: 0.75rem; padding: 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem;"}
          >
            <div
              style={"font-size: 0.75rem; font-weight: 600; color: " +
                textColor +
                "; text-transform: uppercase; letter-spacing: 0.05em;"}
            >
              Child {String(idx)}
            </div>
            <div style="
                font-size: 2rem;
                font-weight: 700;
                color: #0f172a;
              ">
              {String(value)}
            </div>
            <div style="
                font-size: 0.8rem;
                color: #64748b;
                font-style: italic;
              ">
              {label}
            </div>
          </div>
        );
      });

      return (
        <div style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 0.75rem;
          ">
          {items}
        </div>
      );
    })(childrenView);

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
                gap: 1.5rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                  ">
                  Handler spawn pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Spawn child counters from handlers
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Demonstrates handlers that spawn new child recipe instances
                  dynamically. Each child counter is created with an initial
                  seed value and maintains its own independent state.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(1, minmax(0, 1fr));
                ">
                <div style="
                    background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Child Counters
                  </span>
                  <strong
                    data-testid="child-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {childCount}
                  </strong>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Spawn child counter
                </h3>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    data-testid="seed-input"
                    type="number"
                    placeholder="Initial seed value"
                    $value={seedField}
                    aria-label="Enter seed value"
                    style="flex: 1;"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="spawn-button"
                    onClick={spawn}
                    variant="primary"
                  >
                    Spawn Child
                  </ct-button>
                </div>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Enter a seed value and click "Spawn Child" to create a new
                  child counter.
                </span>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Increment child
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: 120px 120px 1fr;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    data-testid="child-index-input"
                    type="number"
                    placeholder="Child #"
                    $value={incrementIndexField}
                    aria-label="Child index"
                  >
                  </ct-input>
                  <ct-input
                    data-testid="increment-amount-input"
                    type="number"
                    placeholder="Amount"
                    $value={incrementAmountField}
                    aria-label="Amount to increment"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="increment-button"
                    onClick={incrementFromFields}
                    variant="primary"
                  >
                    Increment
                  </ct-button>
                </div>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Enter a child index (0-based) and amount to increment that
                  child's value.
                </span>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                ">
                <h3 style="
                    margin: 0 0 0.75rem 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Child counters
                </h3>
                {childrenUi}
              </div>
            </div>
          </ct-card>
        </div>
      ),
      children: childrenView,
      childCount,
      spawn: spawnChild({ children }),
      incrementChild: incrementChild({ children }),
    };
  },
);

export default counterWithHandlerSpawnUx;
