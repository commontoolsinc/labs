/// <cts-enable />
import {
  type Cell,
  cell,
  createCell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface NestedHandlerArgs {
  value: Default<number, 0>;
  history: Default<PipelineHistoryEntry[], []>;
}

type StageEntry = {
  base: number;
  multiplier: number;
  delta: number;
  tag: string;
};

type PreparedSnapshot = {
  delta: number;
  tag: string;
};

type PipelineHistoryEntry = {
  value: number;
  delta: number;
  tag: string;
};

interface StageContext {
  stage: Cell<StageEntry | undefined>;
  preparedCount: Cell<number>;
  lastPrepared: Cell<PreparedSnapshot>;
}

const updateStage = (
  event: { amount?: number; multiplier?: number; tag?: string } | undefined,
  context: StageContext,
) => {
  const base = typeof event?.amount === "number" ? event.amount : 0;
  const multiplier = typeof event?.multiplier === "number"
    ? event.multiplier
    : 1;
  const safeMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
  const safeBase = Number.isFinite(base) ? base : 0;
  const tag = typeof event?.tag === "string" && event.tag.length > 0
    ? event.tag
    : "pipeline";
  const delta = safeBase * safeMultiplier;

  context.stage.set({
    base: safeBase,
    multiplier: safeMultiplier,
    delta,
    tag,
  });

  const preparedSoFar = context.preparedCount.get() ?? 0;
  context.preparedCount.set(preparedSoFar + 1);

  context.lastPrepared.set({ delta, tag });

  createCell<PreparedSnapshot>(
    {
      type: "object",
      required: ["delta", "tag"],
      additionalProperties: false,
      properties: {
        delta: { type: "number" },
        tag: { type: "string" },
      },
    },
    "nestedHandlerDebug",
    { delta, tag },
  );
};

const applyStagedAdjustment = handler(
  (
    _event: unknown,
    context: {
      value: Cell<number>;
      history: Cell<PipelineHistoryEntry[]>;
      stage: Cell<StageEntry | undefined>;
      appliedCount: Cell<number>;
    },
  ) => {
    applyStageEntry(context);
  },
);

const applyStageEntry = (
  context: {
    value: Cell<number>;
    history: Cell<PipelineHistoryEntry[]>;
    stage: Cell<StageEntry | undefined>;
    appliedCount: Cell<number>;
  },
) => {
  const staged = context.stage.get();
  if (!staged) return;

  const currentValue = context.value.get() ?? 0;
  const nextValue = currentValue + staged.delta;
  context.value.set(nextValue);

  const existingHistory = context.history.get();
  const history = Array.isArray(existingHistory) ? existingHistory.slice() : [];
  history.push({
    value: nextValue,
    delta: staged.delta,
    tag: staged.tag,
  });
  context.history.set(history);

  const appliedSoFar = context.appliedCount.get() ?? 0;
  context.appliedCount.set(appliedSoFar + 1);

  context.stage.set(undefined);
};

const stageOnly = handler(
  (
    event: { amount?: number; multiplier?: number; tag?: string } | undefined,
    context: StageContext,
  ) => {
    updateStage(event, context);
  },
);

const composeAndApply = handler(
  (
    event: { amount?: number; multiplier?: number; tag?: string } | undefined,
    context: StageContext & {
      value: Cell<number>;
      history: Cell<PipelineHistoryEntry[]>;
      stage: Cell<StageEntry | undefined>;
      appliedCount: Cell<number>;
    },
  ) => {
    updateStage(event, context);
    applyStageEntry(context);
  },
);

/** Pattern composing nested handlers to simulate staged pipelines. */
export const counterWithNestedHandlerComposition = recipe<NestedHandlerArgs>(
  "Counter With Nested Handler Composition",
  ({ value, history }) => {
    const stage = cell<StageEntry | undefined>(undefined);
    const preparedCount = cell(0);
    const appliedCount = cell(0);
    const lastPrepared = cell<PreparedSnapshot>({
      delta: 0,
      tag: "pipeline",
    });

    const commit = applyStagedAdjustment({
      value,
      history,
      stage,
      appliedCount,
    });

    const stageHandler = stageOnly({
      stage,
      preparedCount,
      lastPrepared,
    });

    const process = composeAndApply({
      stage,
      preparedCount,
      lastPrepared,
      value,
      history,
      appliedCount,
    });

    const preparedView = lift((count: number | undefined) => count ?? 0)(
      preparedCount,
    );
    const appliedView = lift((count: number | undefined) => count ?? 0)(
      appliedCount,
    );
    const historyView = lift((entries: PipelineHistoryEntry[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(history);
    const lastPreparedView = lift(
      (entry: PreparedSnapshot | undefined) =>
        entry ?? { delta: 0, tag: "pipeline" },
    )(lastPrepared);
    const stageStatus = derive(
      stage,
      (current) => current ? `staged:${current.tag}` : "idle",
    );
    const label = str`${preparedView} prepared, ${appliedView} applied`;

    return {
      value,
      history: historyView,
      stats: {
        prepared: preparedView,
        applied: appliedView,
      },
      lastPrepared: lastPreparedView,
      stageStatus,
      label,
      pipeline: {
        stage: stageHandler,
        commit,
        process,
      },
    };
  },
);
