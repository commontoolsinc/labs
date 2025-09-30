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
  UI,
} from "commontools";

type PipelineMode = "double" | "mirror";

interface TogglePipelineArgs {
  count: Default<number, 0>;
  mode: Default<PipelineMode, "double">;
}

type PipelineResult = {
  mapped: number;
  label: string;
  status: string;
};

type PipelineFn = (value: number) => PipelineResult;

const doublePipeline: PipelineFn = (value) => {
  const mapped = value * 2;
  return {
    mapped,
    label: `Double pipeline -> ${mapped}`,
    status: `${value} doubled to ${mapped}`,
  };
};

const mirrorPipeline: PipelineFn = (value) => {
  const mapped = -value;
  return {
    mapped,
    label: `Mirror pipeline -> ${mapped}`,
    status: `${value} mirrored to ${mapped}`,
  };
};

const adjustCount = handler(
  (
    event: { amount?: number } | undefined,
    context: { count: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.count.get();
    const base = typeof current === "number" ? current : 0;
    context.count.set(base + amount);
  },
);

const toggleHandler = handler(
  (
    event: { mode?: PipelineMode } | undefined,
    context: {
      mode: Cell<PipelineMode>;
      switches: Cell<number>;
      history: Cell<PipelineMode[]>;
    },
  ) => {
    const currentMode = context.mode.get();
    const safeMode = currentMode === "mirror" ? "mirror" : "double";
    const requested = event?.mode;
    const next = requested === "mirror"
      ? "mirror"
      : requested === "double"
      ? "double"
      : safeMode === "mirror"
      ? "double"
      : "mirror";

    if (next !== safeMode) {
      context.mode.set(next);
      const switchCount = context.switches.get();
      const steps = typeof switchCount === "number" ? switchCount : 0;
      context.switches.set(steps + 1);
    }

    const historyState = context.history.get();
    const currentHistory = Array.isArray(historyState) ? historyState : [];
    context.history.set([...currentHistory, next]);
  },
);

export const counterWithToggledDerivePipelinesUx = recipe<TogglePipelineArgs>(
  "Counter With Toggled Derive Pipelines (UX)",
  ({ count, mode }) => {
    const switchCount = cell(0);
    const pipelineHistory = cell<PipelineMode[]>([]);

    const safeCount = lift((value: number | undefined) =>
      typeof value === "number" ? value : 0
    )(count);
    const safeMode = lift((value: PipelineMode | undefined) =>
      value === "mirror" ? "mirror" : "double"
    )(mode);

    const pipelineName = safeMode;

    const pipelineResult = lift((inputs: {
      mode: PipelineMode | undefined;
      value: number | undefined;
    }): PipelineResult => {
      const sanitizedMode = inputs.mode === "mirror" ? "mirror" : "double";
      const pipeline = sanitizedMode === "mirror"
        ? mirrorPipeline
        : doublePipeline;
      const value = typeof inputs.value === "number" ? inputs.value : 0;
      return pipeline(value);
    })({
      mode: safeMode,
      value: safeCount,
    });

    const mappedValue = lift((result: PipelineResult) => result.mapped)(
      pipelineResult,
    );
    const status = lift((result: PipelineResult) => result.status)(
      pipelineResult,
    );

    const switchCountView = lift((value: number | undefined) =>
      typeof value === "number" ? value : 0
    )(switchCount);

    const historyView = lift((history: PipelineMode[] | undefined) =>
      Array.isArray(history) ? history : []
    )(pipelineHistory);

    const increment = adjustCount({ count });
    const togglePipeline = toggleHandler({
      mode,
      switches: switchCount,
      history: pipelineHistory,
    });

    const name = str`${pipelineName} → ${mappedValue}`;

    const ui = (
      <ct-card style="padding: 1.5rem; max-width: 600px;">
        <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600;">
          Toggled Derive Pipelines
        </h2>
        <p style="margin: 0 0 1.5rem 0; color: #666; line-height: 1.5;">
          This pattern demonstrates swapping between derive pipelines based on a
          mode argument. The active pipeline reference changes without
          rebuilding the surrounding reactive graph.
        </p>

        <ct-card style="padding: 1rem; margin-bottom: 1.5rem; background: #f8f9fa;">
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; text-align: center;">
            <div>
              <div style="font-size: 0.875rem; color: #666; margin-bottom: 0.25rem;">
                Input Count
              </div>
              <div
                style={lift((v: number) =>
                  "font-size: 1.5rem; font-weight: 600; font-family: monospace; color: " +
                  (v >= 0 ? "#0066cc" : "#cc0066") + ";"
                )(safeCount)}
              >
                {safeCount}
              </div>
            </div>
            <div>
              <div style="font-size: 0.875rem; color: #666; margin-bottom: 0.25rem;">
                Active Pipeline
              </div>
              <div
                style={lift((mode: PipelineMode) =>
                  "font-size: 1.125rem; font-weight: 600; padding: 0.25rem 0.75rem; border-radius: 0.375rem; display: inline-block; background: " +
                  (mode === "double" ? "#dbeafe" : "#fce7f3") + "; color: " +
                  (mode === "double" ? "#1e40af" : "#be185d") + ";"
                )(safeMode)}
              >
                {pipelineName}
              </div>
            </div>
            <div>
              <div style="font-size: 0.875rem; color: #666; margin-bottom: 0.25rem;">
                Output Value
              </div>
              <div
                style={lift((v: number) =>
                  "font-size: 1.5rem; font-weight: 600; font-family: monospace; color: " +
                  (v >= 0 ? "#059669" : "#dc2626") + ";"
                )(mappedValue)}
              >
                {mappedValue}
              </div>
            </div>
          </div>
        </ct-card>

        <ct-card style="padding: 1rem; margin-bottom: 1.5rem; background: #fff; border: 1px solid #e5e7eb;">
          <div style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem;">
            Pipeline Status
          </div>
          <div style="font-family: monospace; font-size: 0.875rem; color: #374151;">
            {status}
          </div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">
            Mode switches:{" "}
            <span style="font-weight: 600;">{switchCountView}</span>
          </div>
        </ct-card>

        <div style="display: flex; gap: 0.75rem; margin-bottom: 1.5rem;">
          <ct-button onClick={increment} ct-amount={1} style="flex: 1;">
            Increment (+1)
          </ct-button>
          <ct-button onClick={increment} ct-amount={-1} style="flex: 1;">
            Decrement (-1)
          </ct-button>
        </div>

        <div style="display: flex; gap: 0.75rem; margin-bottom: 1.5rem;">
          <ct-button onClick={togglePipeline} style="flex: 1;">
            Toggle Pipeline
          </ct-button>
          <ct-button
            onClick={togglePipeline}
            ct-mode="double"
            style="flex: 1; background: #dbeafe; color: #1e40af;"
          >
            → Double
          </ct-button>
          <ct-button
            onClick={togglePipeline}
            ct-mode="mirror"
            style="flex: 1; background: #fce7f3; color: #be185d;"
          >
            → Mirror
          </ct-button>
        </div>

        <ct-card style="padding: 1rem; background: #f9fafb; border: 1px solid #e5e7eb;">
          <div style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.75rem;">
            Pipeline History
          </div>
          <div
            style={lift(
              (history: PipelineMode[]) =>
                "display: flex; gap: 0.5rem; flex-wrap: wrap; " +
                (history.length === 0 ? "color: #9ca3af;" : ""),
            )(historyView)}
          >
            {lift((history: PipelineMode[]) => {
              if (history.length === 0) {
                return (
                  <span style="font-size: 0.875rem;">No switches yet</span>
                );
              }
              const elements = [];
              for (const mode of history.slice().reverse()) {
                const bgColor = mode === "double" ? "#dbeafe" : "#fce7f3";
                const textColor = mode === "double" ? "#1e40af" : "#be185d";
                const style =
                  "padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 500; background: " +
                  bgColor + "; color: " + textColor + ";";
                elements.push(
                  <span style={style}>
                    {mode}
                  </span>,
                );
              }
              return <>{elements}</>;
            })(historyView)}
          </div>
        </ct-card>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      count,
      mode: safeMode,
      pipelineName,
      mappedValue,
      status,
      label: str`${pipelineName} mapped ${mappedValue}`,
      pipelineHistory: historyView,
      switchCount: switchCountView,
      increment,
      togglePipeline,
    };
  },
);
