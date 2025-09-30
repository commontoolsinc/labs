/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  toSchema,
  UI,
} from "commontools";

interface ReplicatorArgs {
  seeds: Default<number[], []>;
}

interface AdjustReplicaContext {
  values: Cell<number[]>;
  index: Cell<number>;
}

const adjustReplica = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustReplicaContext,
  ) => {
    const requested = context.index.get() ?? 0;
    const values = context.values.get();
    const list = Array.isArray(values) ? values : [];
    if (requested < 0 || requested >= list.length) return;

    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target = context.values.key(requested) as Cell<number>;
    const current = target.get() ?? 0;
    target.set(current + amount);
  },
);

const buildReplicas = lift(
  toSchema<{ seeds: Cell<number[]> }>(),
  toSchema<unknown>(),
  ({ seeds }) => {
    const raw = seeds.get();
    const list = Array.isArray(raw) ? raw : [];

    return list.map((item, index) => {
      const value = typeof item === "number" && Number.isFinite(item)
        ? item
        : 0;
      const name = `Replica ${index + 1}`;
      return {
        index,
        name,
        value,
        label: `${name}: ${value}`,
        controls: {
          increment: adjustReplica({
            values: seeds,
            index: cell(index),
          }),
        },
      };
    });
  },
);

const addReplica = handler(
  (_event: unknown, context: { seeds: Cell<number[]> }) => {
    const values = context.seeds.get();
    const list = Array.isArray(values) ? values : [];
    context.seeds.set([...list, 0]);
  },
);

const removeReplica = handler(
  (
    _event: unknown,
    context: { seeds: Cell<number[]>; indexField: Cell<string> },
  ) => {
    const indexText = context.indexField.get() ?? "";
    const indexNum = Number(indexText);
    if (!Number.isFinite(indexNum)) return;

    const index = Math.trunc(indexNum);
    const values = context.seeds.get();
    const list = Array.isArray(values) ? values : [];
    if (index < 0 || index >= list.length) return;

    const updated = [...list];
    updated.splice(index, 1);
    context.seeds.set(updated);
    context.indexField.set("");
  },
);

export const counterReplicatorUx = recipe<ReplicatorArgs>(
  "Counter Replicator (UX)",
  ({ seeds }) => {
    const replicas = buildReplicas({ seeds });

    const count = lift((items: unknown) => {
      return Array.isArray(items) ? items.length : 0;
    })(replicas);

    const total = lift((items: unknown) => {
      if (!Array.isArray(items)) return 0;
      return items.reduce((sum, entry: any) => {
        const value = typeof entry?.value === "number" ? entry.value : 0;
        return sum + value;
      }, 0);
    })(replicas);

    const summary = str`Replicas ${count} total ${total}`;
    const name = str`Counter Replicator (${count} replicas)`;

    const indexField = cell<string>("");

    const addHandler = addReplica({ seeds });
    const removeHandler = removeReplica({ seeds, indexField });

    const replicaCards = lift<unknown, any>((items: unknown) => {
      if (!Array.isArray(items) || items.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #64748b;
              background: #f8fafc;
              border-radius: 0.5rem;
              border: 1px dashed #cbd5e1;
            ">
            No replicas yet. Add one to get started!
          </div>
        );
      }

      const elements = [];
      for (const item of items) {
        const index = typeof item?.index === "number" ? item.index : 0;
        const name = typeof item?.name === "string" ? item.name : "Replica";
        const value = typeof item?.value === "number" ? item.value : 0;
        const handler = item?.controls?.increment;

        const cardBg = "linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)";
        const cardBorder = "2px solid #bae6fd";
        const indexBg = "#0ea5e9";
        const valueBg = "#0c4a6e";

        const card = h(
          "ct-card",
          {
            style: "background: " + cardBg + "; border: " + cardBorder +
              "; border-radius: 0.75rem;",
          },
          h(
            "div",
            {
              slot: "content",
              style:
                "display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: center;",
              },
              h(
                "div",
                { style: "display: flex; align-items: center; gap: 0.75rem;" },
                h(
                  "span",
                  {
                    style:
                      "display: inline-block; width: 2rem; height: 2rem; border-radius: 50%; background: " +
                      indexBg +
                      "; color: white; text-align: center; line-height: 2rem; font-weight: bold; font-size: 0.9rem;",
                  },
                  String(index),
                ),
                h(
                  "span",
                  {
                    style: "font-weight: 600; color: #0c4a6e; font-size: 1rem;",
                  },
                  name,
                ),
              ),
              h(
                "strong",
                {
                  style: "font-size: 2rem; font-family: monospace; color: " +
                    valueBg + ";",
                },
                String(value),
              ),
            ),
            h(
              "ct-button",
              {
                onClick: handler,
                "aria-label": "Increment " + name,
              },
              "Increment +1",
            ),
          ),
        );
        elements.push(card);
      }
      return h("div", {
        style: "display: flex; flex-direction: column; gap: 1rem;",
      }, ...elements);
    })(replicas);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
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
                  Counter Replicator
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Manage multiple counter replicas
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Create and manage independent counter instances, each with
                  their own value. Increment individual counters and track the
                  total across all replicas.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  border: 2px solid #fde047;
                ">
                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 1.5rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="
                        font-size: 0.8rem;
                        color: #78350f;
                        font-weight: 500;
                      ">
                      Replica count
                    </span>
                    <strong style="
                        font-size: 2.5rem;
                        color: #78350f;
                        font-family: monospace;
                      ">
                      {count}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="
                        font-size: 0.8rem;
                        color: #78350f;
                        font-weight: 500;
                      ">
                      Total value
                    </span>
                    <strong style="
                        font-size: 2.5rem;
                        color: #78350f;
                        font-family: monospace;
                      ">
                      {total}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

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
                Replica controls
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
                  gap: 0.75rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  onClick={addHandler}
                  aria-label="Add new replica"
                >
                  Add replica
                </ct-button>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr auto;
                  gap: 0.75rem;
                  align-items: end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="index-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Remove by index
                  </label>
                  <ct-input
                    id="index-input"
                    type="number"
                    step="1"
                    $value={indexField}
                    aria-label="Enter replica index to remove"
                  >
                  </ct-input>
                </div>
                <ct-button
                  variant="secondary"
                  onClick={removeHandler}
                  aria-label="Remove replica"
                >
                  Remove
                </ct-button>
              </div>
            </div>
          </ct-card>

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
                Replicas
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
              {replicaCards}
            </div>
          </ct-card>

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
      seeds,
      replicas,
      count,
      total,
      summary,
    };
  },
);

export default counterReplicatorUx;
