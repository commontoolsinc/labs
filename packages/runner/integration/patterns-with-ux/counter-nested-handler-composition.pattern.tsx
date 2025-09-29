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

const toInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const toValidMultiplier = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
};

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

/** Pattern composing nested handlers to simulate staged pipelines with UX. */
export const counterWithNestedHandlerCompositionUx = recipe<NestedHandlerArgs>(
  "Counter With Nested Handler Composition (UX)",
  ({ value, history }) => {
    const stage = cell<StageEntry | undefined>(undefined);
    const preparedCount = cell(0);
    const appliedCount = cell(0);
    const lastPrepared = cell<PreparedSnapshot>({
      delta: 0,
      tag: "pipeline",
    });

    // UI cells for form inputs
    const amountField = cell<string>("0");
    const multiplierField = cell<string>("1");
    const tagField = cell<string>("pipeline");

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

    // UI handlers
    const stageFromInput = handler<
      unknown,
      {
        amountField: Cell<string>;
        multiplierField: Cell<string>;
        tagField: Cell<string>;
        stage: Cell<StageEntry | undefined>;
        preparedCount: Cell<number>;
        lastPrepared: Cell<PreparedSnapshot>;
      }
    >((_event, ctx) => {
      const amount = Number(ctx.amountField.get());
      const multiplier = Number(ctx.multiplierField.get());
      const tag = ctx.tagField.get();
      updateStage(
        {
          amount: toInteger(amount, 0),
          multiplier: toValidMultiplier(multiplier, 1),
          tag: tag || "pipeline",
        },
        {
          stage: ctx.stage,
          preparedCount: ctx.preparedCount,
          lastPrepared: ctx.lastPrepared,
        },
      );
    })({
      amountField,
      multiplierField,
      tagField,
      stage,
      preparedCount,
      lastPrepared,
    });

    const processFromInput = handler<
      unknown,
      {
        amountField: Cell<string>;
        multiplierField: Cell<string>;
        tagField: Cell<string>;
        stage: Cell<StageEntry | undefined>;
        preparedCount: Cell<number>;
        lastPrepared: Cell<PreparedSnapshot>;
        value: Cell<number>;
        history: Cell<PipelineHistoryEntry[]>;
        appliedCount: Cell<number>;
      }
    >((_event, ctx) => {
      const amount = Number(ctx.amountField.get());
      const multiplier = Number(ctx.multiplierField.get());
      const tag = ctx.tagField.get();
      updateStage(
        {
          amount: toInteger(amount, 0),
          multiplier: toValidMultiplier(multiplier, 1),
          tag: tag || "pipeline",
        },
        {
          stage: ctx.stage,
          preparedCount: ctx.preparedCount,
          lastPrepared: ctx.lastPrepared,
        },
      );
      applyStageEntry({
        value: ctx.value,
        history: ctx.history,
        stage: ctx.stage,
        appliedCount: ctx.appliedCount,
      });
    })({
      amountField,
      multiplierField,
      tagField,
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

    const currentValue = lift((v: number | undefined) => v ?? 0)(value);
    const historyLength = derive(historyView, (h) => h.length);

    const hasStagedData = derive(stage, (s) => s !== undefined);

    const stageBorderColor = lift((s: StageEntry | undefined) => {
      if (!s) return "#e2e8f0";
      return s.delta >= 0 ? "#10b981" : "#ef4444";
    })(stage);

    const stageCardStyle = lift(
      ({ hasData, border }: { hasData: boolean; border: string }) =>
        hasData
          ? `display: block; border: 2px solid ${border}; background: white; border-radius: 0.5rem; padding: 0.75rem;`
          : "display: none;",
    )({ hasData: hasStagedData, border: stageBorderColor });

    const name = str`Nested handler pipeline (${currentValue})`;

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
                  Nested handler composition
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Multi-stage pipeline with nested handlers
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates handler composition where operations can be
                  staged separately or processed immediately. The pipeline
                  tracks both prepared and applied operations.
                </p>
              </div>

              <div style="
                  background: #f8fafc;
                  border: 2px solid #e2e8f0;
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Current value
                    </span>
                    <strong style="font-size: 3rem; color: #0f172a;">
                      {currentValue}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      gap: 1.5rem;
                    ">
                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.25rem;
                        align-items: center;
                      ">
                      <span style="font-size: 0.75rem; color: #64748b;">
                        Prepared
                      </span>
                      <strong style="font-size: 1.5rem; color: #3b82f6;">
                        {preparedView}
                      </strong>
                    </div>
                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.25rem;
                        align-items: center;
                      ">
                      <span style="font-size: 0.75rem; color: #64748b;">
                        Applied
                      </span>
                      <strong style="font-size: 1.5rem; color: #10b981;">
                        {appliedView}
                      </strong>
                    </div>
                  </div>
                </div>

                <div style={stageCardStyle}>
                  <div style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    ">
                    <span style="
                        font-size: 0.85rem;
                        color: #475569;
                        font-weight: 500;
                      ">
                      📦 Staged operation
                    </span>
                    {lift((s: StageEntry | undefined) => {
                      if (!s) return null;
                      return (
                        <div style="
                            display: flex;
                            gap: 1rem;
                            font-size: 0.85rem;
                          ">
                          <span style="color: #64748b;">
                            Base: <strong>{s.base}</strong>
                          </span>
                          <span style="color: #64748b;">
                            × <strong>{s.multiplier}</strong>
                          </span>
                          <span style="color: #0f172a;">
                            = <strong>{s.delta}</strong>
                          </span>
                          <span style="
                              background: #e0e7ff;
                              color: #3730a3;
                              padding: 0.125rem 0.5rem;
                              border-radius: 0.25rem;
                              font-weight: 500;
                            ">
                            {s.tag}
                          </span>
                        </div>
                      );
                    })(stage)}
                  </div>
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
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
                    Base amount
                  </label>
                  <ct-input
                    id="amount-input"
                    type="number"
                    step="1"
                    $value={amountField}
                    aria-label="Set base amount"
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="multiplier-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Multiplier
                  </label>
                  <ct-input
                    id="multiplier-input"
                    type="number"
                    step="0.1"
                    $value={multiplierField}
                    aria-label="Set multiplier"
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="tag-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Operation tag
                  </label>
                  <ct-input
                    id="tag-input"
                    type="text"
                    $value={tagField}
                    aria-label="Set operation tag"
                  >
                  </ct-input>
                </div>
              </div>

              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  onClick={stageFromInput}
                  variant="secondary"
                  aria-label="Stage operation"
                >
                  📦 Stage only
                </ct-button>
                <ct-button
                  onClick={commit}
                  disabled={lift((hasData: boolean) => !hasData)(hasStagedData)}
                  aria-label="Commit staged operation"
                >
                  ✓ Commit staged
                </ct-button>
                <ct-button
                  onClick={processFromInput}
                  aria-label="Stage and apply immediately"
                >
                  ⚡ Stage + Apply
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
                Pipeline history
              </h3>
              <span style="
                  background: #e2e8f0;
                  color: #475569;
                  padding: 0.25rem 0.5rem;
                  border-radius: 0.25rem;
                  font-size: 0.75rem;
                  font-weight: 600;
                ">
                {historyLength} operations
              </span>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 20rem;
                overflow-y: auto;
              "
            >
              {lift((entries: PipelineHistoryEntry[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="
                        padding: 1rem;
                        text-align: center;
                        color: #94a3b8;
                        font-size: 0.9rem;
                      ">
                      No operations applied yet
                    </div>
                  );
                }
                return entries
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <div
                      key={entries.length - index}
                      style={entry.delta >= 0
                        ? "background: #f0fdf4; border: 1px solid #bbf7d0; padding: 0.75rem; border-radius: 0.5rem;"
                        : "background: #fef2f2; border: 1px solid #fecaca; padding: 0.75rem; border-radius: 0.5rem;"}
                    >
                      <div style="
                          display: flex;
                          justify-content: space-between;
                          align-items: center;
                          font-size: 0.85rem;
                        ">
                        <div style="display: flex; gap: 1rem;">
                          <span
                            style={entry.delta >= 0
                              ? "color: #166534; font-weight: 500;"
                              : "color: #991b1b; font-weight: 500;"}
                          >
                            {entry.delta >= 0 ? "+" : ""}
                            {entry.delta}
                          </span>
                          <span style="
                              background: #e0e7ff;
                              color: #3730a3;
                              padding: 0.125rem 0.5rem;
                              border-radius: 0.25rem;
                              font-size: 0.75rem;
                              font-weight: 500;
                            ">
                            {entry.tag}
                          </span>
                        </div>
                        <span style="color: #475569; font-weight: 500;">
                          → {entry.value}
                        </span>
                      </div>
                    </div>
                  ));
              })(historyView)}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label} · Status: {stageStatus}
          </div>
        </div>
      ),
      value,
      history,
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
      ui: {
        stageFromInput,
        processFromInput,
      },
    };
  },
);

export default counterWithNestedHandlerCompositionUx;
