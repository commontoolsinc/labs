/// <cts-enable />
import {
  cell,
  createCell,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";
import type { Cell } from "commontools";

type PipelineMode = "double" | "mirror";

/**
 * Arguments controlling the toggled derive pipeline counter.
 * `mode` selects which derive pipeline runs against the sanitized count.
 */

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

/**
 * Counter pattern that swaps between derive pipelines based on an argument-
 * backed mode cell. The active pipeline reference changes without rebuilding
 * the surrounding reactive graph.
 */
export const counterWithToggledDerivePipelines = recipe<TogglePipelineArgs>(
  "Counter With Toggled Derive Pipelines",
  ({ count, mode }) => {
    const switchCount = cell(0);
    const pipelineHistory = cell<PipelineMode[]>([]);
    let historyState: PipelineMode[] = [];
    const switchCountView = lift((value: number | undefined) =>
      typeof value === "number" ? value : 0
    )(switchCount);
    const historyView = lift((_: number) => historyState)(switchCountView);

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

    const togglePipeline = handler(
      (
        event: { mode?: PipelineMode } | undefined,
        context: {
          mode: Cell<PipelineMode>;
          switches: Cell<number>;
        },
      ) => {
        const current = safeMode.get();
        const currentMode = current === "mirror" ? "mirror" : "double";
        const requested = event?.mode;
        const next = requested === "mirror"
          ? "mirror"
          : requested === "double"
          ? "double"
          : currentMode === "mirror"
          ? "double"
          : "mirror";

        if (next !== currentMode) {
          context.mode.set(next);
          const switchCount = context.switches.get();
          const steps = typeof switchCount === "number" ? switchCount : 0;
          context.switches.set(steps + 1);
        }

        historyState = [...historyState, next];
        pipelineHistory.set(historyState);

        createCell(
          {
            type: "object",
            additionalProperties: false,
            required: ["mode", "historySize"],
            properties: {
              mode: { type: "string" },
              historySize: { type: "number" },
            },
          },
          "counterToggledDerivePipelineSnapshot",
          { mode: next, historySize: historyState.length },
        );
      },
    );

    return {
      count,
      mode: safeMode,
      pipelineName,
      mappedValue,
      status,
      label: str`${pipelineName} mapped ${mappedValue}`,
      pipelineHistory: historyView,
      switchCount: switchCountView,
      increment: adjustCount({ count }),
      togglePipeline: togglePipeline({
        mode,
        switches: switchCount,
      }),
    };
  },
);
