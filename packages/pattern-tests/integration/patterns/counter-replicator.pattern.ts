/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
  toSchema,
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

export const counterReplicator = recipe<ReplicatorArgs>(
  "Counter Replicator",
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

    return {
      seeds,
      replicas,
      count,
      total,
      summary,
    };
  },
);
