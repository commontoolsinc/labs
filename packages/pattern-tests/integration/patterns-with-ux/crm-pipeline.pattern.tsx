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

interface StageConfigInput {
  id?: string;
  label?: string;
  probability?: number;
}

interface StageConfig {
  id: string;
  label: string;
  probability: number;
}

interface DealInput {
  id?: string;
  name?: string;
  stage?: string;
  amount?: number;
}

interface DealState {
  id: string;
  name: string;
  stage: string;
  amount: number;
}

interface StageStat {
  id: string;
  label: string;
  probability: number;
  totalAmount: number;
  forecastAmount: number;
  dealCount: number;
  share: number;
}

interface StageTotals {
  stats: StageStat[];
  openTotal: number;
  weightedTotal: number;
}

interface PipelineArgs {
  deals: Default<DealInput[], []>;
  stages: Default<StageConfigInput[], []>;
  defaultAmount: Default<number, 1000>;
}

const defaultStages: StageConfig[] = [
  { id: "prospect", label: "Prospect", probability: 0.2 },
  { id: "qualified", label: "Qualified", probability: 0.4 },
  { id: "proposal", label: "Proposal", probability: 0.6 },
  { id: "negotiation", label: "Negotiation", probability: 0.8 },
  { id: "closed-won", label: "Closed Won", probability: 1 },
];

const formatLabel = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const clampProbability = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.round(clamped * 100) / 100;
};

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeStageConfigs = (input: unknown): StageConfig[] => {
  if (!Array.isArray(input)) {
    return defaultStages.map((stage) => ({ ...stage }));
  }

  const seen = new Set<string>();
  const sanitized: StageConfig[] = [];
  for (let index = 0; index < input.length; index++) {
    const raw = input[index] as StageConfigInput | undefined;
    const fallbackId = `stage-${index + 1}`;
    const id = formatLabel(raw?.id, fallbackId).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const labelFallback = raw?.label ?? id.replace(/-/g, " ");
    const label = formatLabel(labelFallback, id.toUpperCase());
    const defaultProbability = defaultStages[index]?.probability ?? 0;
    const probability = clampProbability(
      raw?.probability,
      defaultProbability,
    );
    sanitized.push({ id, label, probability });
  }

  if (sanitized.length === 0) {
    return defaultStages.map((stage) => ({ ...stage }));
  }

  return sanitized;
};

const ensureStages = (
  stages: readonly StageConfig[] | undefined,
): StageConfig[] => {
  if (Array.isArray(stages) && stages.length > 0) {
    return stages.map((stage) => ({ ...stage }));
  }
  return defaultStages.map((stage) => ({ ...stage }));
};

const sanitizeAmount = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(input, 0));
};

const sanitizeDealName = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeDealStage = (
  input: unknown,
  stages: readonly StageConfig[],
  fallbackStage: string,
): string => {
  if (typeof input === "string") {
    const candidate = input.trim().toLowerCase();
    if (stages.some((stage) => stage.id === candidate)) {
      return candidate;
    }
  }
  return fallbackStage;
};

const sanitizeDeals = (
  input: unknown,
  stages: readonly StageConfig[],
): DealState[] => {
  if (!Array.isArray(input)) return [];
  const sanitized: DealState[] = [];
  const fallbackStage = stages[0]?.id ?? defaultStages[0].id;

  for (let index = 0; index < input.length; index++) {
    const raw = input[index] as DealInput | undefined;
    const id = formatLabel(raw?.id, `deal-${index + 1}`).toLowerCase();
    const name = sanitizeDealName(raw?.name, `Deal ${index + 1}`);
    const stage = sanitizeDealStage(raw?.stage, stages, fallbackStage);
    const amount = sanitizeAmount(raw?.amount, 0);
    sanitized.push({ id, name, stage, amount });
  }

  sanitized.sort((left, right) => {
    const leftOrder = stages.findIndex((stage) => stage.id === left.stage);
    const rightOrder = stages.findIndex((stage) => stage.id === right.stage);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name);
  });

  return sanitized;
};

const generateDealId = (
  deals: readonly DealState[],
  idSeed: Cell<number>,
): string => {
  const used = new Set(deals.map((deal) => deal.id));
  let seed = (idSeed.get() ?? deals.length) + 1;
  let candidate = `deal-${seed}`;
  while (used.has(candidate)) {
    seed += 1;
    candidate = `deal-${seed}`;
  }
  idSeed.set(seed);
  return candidate;
};

const toDealInputs = (deals: readonly DealState[]): DealInput[] => {
  return deals.map((deal) => ({
    id: deal.id,
    name: deal.name,
    stage: deal.stage,
    amount: deal.amount,
  }));
};

const computeStageTotals = (
  stages: readonly StageConfig[],
  deals: readonly DealState[],
): StageTotals => {
  const stats: StageStat[] = stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    probability: roundCurrency(stage.probability),
    totalAmount: 0,
    forecastAmount: 0,
    dealCount: 0,
    share: 0,
  }));

  const indexById = new Map<string, number>();
  for (let index = 0; index < stats.length; index++) {
    indexById.set(stats[index].id, index);
  }

  for (const deal of deals) {
    const index = indexById.get(deal.stage) ?? 0;
    const stage = stats[index];
    stage.totalAmount = roundCurrency(stage.totalAmount + deal.amount);
    stage.dealCount += 1;
  }

  let openTotal = 0;
  let weightedTotal = 0;

  for (const entry of stats) {
    openTotal += entry.totalAmount;
    entry.forecastAmount = roundCurrency(entry.totalAmount * entry.probability);
    weightedTotal += entry.forecastAmount;
  }

  const safeWeighted = roundCurrency(weightedTotal);
  for (const entry of stats) {
    if (safeWeighted === 0) {
      entry.share = 0;
    } else {
      entry.share = roundCurrency(entry.forecastAmount / safeWeighted);
    }
  }

  return {
    stats,
    weightedTotal: safeWeighted,
    openTotal: roundCurrency(openTotal),
  };
};

const formatCurrency = (value: number | undefined): string => {
  const safeValue = typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
  return safeValue.toFixed(2);
};

export const crmPipelineUx = recipe<PipelineArgs>(
  "CRM Pipeline",
  ({ deals, stages, defaultAmount }) => {
    const lastAction = cell("none");
    const idSeed = cell(0);

    const stageList = lift((value: StageConfigInput[] | undefined) =>
      sanitizeStageConfigs(value)
    )(stages);

    const defaultAmountValue = lift((value: number | undefined) => {
      const sanitized = sanitizeAmount(value, 1000);
      return sanitized === 0 ? 1000 : sanitized;
    })(defaultAmount);

    const dealView = lift((value: DealInput[] | undefined) => {
      const stagesValue = ensureStages(stageList.get());
      return sanitizeDeals(value, stagesValue);
    })(deals);

    const totals = lift((list: DealState[] | undefined) => {
      const stagesValue = ensureStages(stageList.get());
      const dealsValue = Array.isArray(list) ? list : [];
      const result = computeStageTotals(stagesValue, dealsValue);
      return result;
    })(dealView);

    const stageStats = derive(totals, (value) => value.stats);
    const totalForecast = derive(totals, (value) => value.weightedTotal);
    const openPipeline = derive(totals, (value) => value.openTotal);

    // UI state
    const dealNameField = cell<string>("");
    const dealAmountField = cell<string>("");
    const dealStageField = cell<string>("");
    const dealIdField = cell<string>("");

    // Add deal handler
    const addDeal = handler<
      unknown,
      {
        nameField: Cell<string>;
        amountField: Cell<string>;
        stageField: Cell<string>;
        deals: Cell<DealInput[]>;
        stages: Cell<StageConfig[]>;
        defaultAmount: Cell<number>;
        idSeed: Cell<number>;
      }
    >((_event, context) => {
      const stages = ensureStages(context.stages.get());
      const fallbackStage = stages[0]?.id ?? defaultStages[0].id;
      const existingDeals = sanitizeDeals(context.deals.get(), stages);

      const nameInput = context.nameField.get();
      const name = typeof nameInput === "string" && nameInput.trim() !== ""
        ? nameInput.trim()
        : `Deal ${existingDeals.length + 1}`;

      const amountInput = context.amountField.get();
      const amount =
        typeof amountInput === "string" && amountInput.trim() !== ""
          ? sanitizeAmount(
            Number(amountInput),
            context.defaultAmount.get() || 1000,
          )
          : sanitizeAmount(context.defaultAmount.get(), 1000);

      const stageInput = context.stageField.get();
      const stage = sanitizeDealStage(stageInput, stages, fallbackStage);

      const newId = generateDealId(existingDeals, context.idSeed);
      existingDeals.push({ id: newId, name, stage, amount });

      existingDeals.sort((left, right) => {
        const leftOrder = stages.findIndex((s) => s.id === left.stage);
        const rightOrder = stages.findIndex((s) => s.id === right.stage);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.name.localeCompare(right.name);
      });

      context.deals.set(toDealInputs(existingDeals));
      context.nameField.set("");
      context.amountField.set("");
      context.stageField.set("");
    })({
      nameField: dealNameField,
      amountField: dealAmountField,
      stageField: dealStageField,
      deals,
      stages: stageList,
      defaultAmount: defaultAmountValue,
      idSeed,
    });

    // Advance deal handler
    const advanceDeal = handler<
      unknown,
      {
        idField: Cell<string>;
        deals: Cell<DealInput[]>;
        stages: Cell<StageConfig[]>;
      }
    >((_event, context) => {
      const stages = ensureStages(context.stages.get());
      if (stages.length === 0) return;
      const existingDeals = sanitizeDeals(context.deals.get(), stages);

      const targetIdInput = context.idField.get();
      const targetId = typeof targetIdInput === "string"
        ? targetIdInput.trim().toLowerCase()
        : "";
      if (targetId === "") return;

      const index = existingDeals.findIndex((deal) => deal.id === targetId);
      if (index === -1) return;

      const currentStageIndex = stages.findIndex((stage) =>
        stage.id === existingDeals[index].stage
      );
      const nextIndex = Math.min(currentStageIndex + 1, stages.length - 1);
      const nextStage = stages[nextIndex]?.id ?? existingDeals[index].stage;

      existingDeals[index] = {
        ...existingDeals[index],
        stage: nextStage,
      };

      existingDeals.sort((left, right) => {
        const leftOrder = stages.findIndex((s) => s.id === left.stage);
        const rightOrder = stages.findIndex((s) => s.id === right.stage);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.name.localeCompare(right.name);
      });

      context.deals.set(toDealInputs(existingDeals));
      context.idField.set("");
    })({ idField: dealIdField, deals, stages: stageList });

    const name = str`CRM Pipeline`;

    // Build stage cards with lift
    const stageCardsUI = lift((stats: StageStat[]) => {
      const stageCards = [];
      for (const stat of stats) {
        const percentage = String(Math.round(stat.probability * 100));
        const bgColor = stat.probability >= 0.8
          ? "#10b981"
          : stat.probability >= 0.5
          ? "#3b82f6"
          : "#6366f1";

        stageCards.push(
          h("div", {
            style: "background: " + bgColor +
              "; color: white; padding: 1rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);",
          }, [
            h("div", {
              style:
                "font-weight: 600; font-size: 0.875rem; margin-bottom: 0.5rem;",
            }, stat.label),
            h("div", {
              style:
                "display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.875rem;",
            }, [
              h("div", {}, [
                h("div", { style: "opacity: 0.9;" }, "Deals"),
                h(
                  "div",
                  { style: "font-size: 1.25rem; font-weight: 700;" },
                  String(stat.dealCount),
                ),
              ]),
              h("div", {}, [
                h("div", { style: "opacity: 0.9;" }, "Value"),
                h(
                  "div",
                  { style: "font-size: 1.25rem; font-weight: 700;" },
                  "$" + formatCurrency(stat.totalAmount),
                ),
              ]),
            ]),
            h("div", {
              style:
                "margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.3);",
            }, [
              h(
                "div",
                { style: "opacity: 0.9; font-size: 0.75rem;" },
                percentage + "% probability",
              ),
              h("div", {
                style:
                  "font-size: 1rem; font-weight: 600; margin-top: 0.25rem;",
              }, "Forecast: $" + formatCurrency(stat.forecastAmount)),
            ]),
          ]),
        );
      }
      return h("div", {
        style:
          "display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem;",
      }, ...stageCards);
    })(stageStats);

    // Build deal cards with lift
    const dealCardsUI = lift(
      (data: { dealsArr: DealState[]; stats: StageStat[] }) => {
        const dealsArr = data.dealsArr;
        const stats = data.stats;

        if (dealsArr.length === 0) {
          return h("div", {
            style:
              "text-align: center; padding: 3rem; color: #9ca3af; font-style: italic;",
          }, "No deals in pipeline yet. Add your first deal above!");
        }

        const dealCards = [];
        for (const deal of dealsArr) {
          const stageData = stats.find((s) => s.id === deal.stage);
          const stageLabel = stageData ? stageData.label : deal.stage;
          const stageBg = stageData && stageData.probability >= 0.8
            ? "#d1fae5"
            : stageData && stageData.probability >= 0.5
            ? "#dbeafe"
            : "#e0e7ff";
          const stageBorder = stageData && stageData.probability >= 0.8
            ? "#10b981"
            : stageData && stageData.probability >= 0.5
            ? "#3b82f6"
            : "#6366f1";

          dealCards.push(
            h("div", {
              style:
                "background: white; padding: 1rem; border-radius: 8px; border-left: 4px solid " +
                stageBorder + "; box-shadow: 0 1px 3px rgba(0,0,0,0.1);",
            }, [
              h("div", {
                style:
                  "display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;",
              }, [
                h(
                  "div",
                  { style: "font-weight: 600; color: #1f2937;" },
                  deal.name,
                ),
                h("div", {
                  style:
                    "font-weight: 700; color: #059669; font-size: 1.125rem;",
                }, "$" + formatCurrency(deal.amount)),
              ]),
              h("div", {
                style: "display: flex; align-items: center; gap: 0.5rem;",
              }, [
                h("span", {
                  style: "background: " + stageBg + "; color: " + stageBorder +
                    "; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; border: 1px solid " +
                    stageBorder + ";",
                }, stageLabel),
                h("span", {
                  style:
                    "color: #6b7280; font-size: 0.75rem; font-family: monospace;",
                }, deal.id),
              ]),
            ]),
          );
        }
        return h("div", {
          style: "display: flex; flex-direction: column; gap: 0.75rem;",
        }, ...dealCards);
      },
    )({ dealsArr: dealView, stats: stageStats });

    const availableStagesText = lift((stats: StageStat[]) => {
      return "Available: " + stats.map((s) => s.id).join(", ");
    })(stageStats);

    const dealCountText = lift((dealsArr: DealState[]) => {
      return "Active Deals (" + String(dealsArr.length) + ")";
    })(dealView);

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 1.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        <div style="background: white; border-radius: 12px; padding: 2rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h1 style="margin: 0 0 0.5rem 0; font-size: 2rem; font-weight: 700; color: #1f2937;">
            Sales Pipeline
          </h1>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 2rem; padding: 1.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px;">
            <div style="text-align: center;">
              <div style="color: rgba(255,255,255,0.9); font-size: 0.875rem; font-weight: 500;">
                Total Pipeline
              </div>
              <div style="color: white; font-size: 2.5rem; font-weight: 700; margin-top: 0.25rem;">
                ${openPipeline}
              </div>
            </div>
            <div style="text-align: center;">
              <div style="color: rgba(255,255,255,0.9); font-size: 0.875rem; font-weight: 500;">
                Weighted Forecast
              </div>
              <div style="color: white; font-size: 2.5rem; font-weight: 700; margin-top: 0.25rem;">
                ${totalForecast}
              </div>
            </div>
          </div>

          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1f2937;">
            Pipeline Stages
          </h2>
          {stageCardsUI}

          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1f2937;">
            Add New Deal
          </h2>
          <div style="background: #f9fafb; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
              <div>
                <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.25rem;">
                  Deal Name
                </label>
                <ct-input
                  $value={dealNameField}
                  placeholder="Enter deal name"
                  style="width: 100%;"
                />
              </div>
              <div>
                <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.25rem;">
                  Amount ($)
                </label>
                <ct-input
                  $value={dealAmountField}
                  placeholder="1000"
                  style="width: 100%;"
                />
              </div>
            </div>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.25rem;">
                Stage ID
              </label>
              <ct-input
                $value={dealStageField}
                placeholder="prospect"
                style="width: 100%;"
              />
              <div style="margin-top: 0.5rem; font-size: 0.75rem; color: #6b7280;">
                {availableStagesText}
              </div>
            </div>
            <ct-button onClick={addDeal} style="width: 100%;">
              Add Deal
            </ct-button>
          </div>

          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1f2937;">
            {dealCountText}
          </h2>
          {dealCardsUI}

          <div style="margin-top: 2rem; padding: 1.5rem; background: #f9fafb; border-radius: 8px;">
            <h3 style="margin: 0 0 1rem 0; font-size: 1rem; font-weight: 600; color: #1f2937;">
              Advance Deal to Next Stage
            </h3>
            <div style="display: flex; gap: 0.75rem;">
              <ct-input
                $value={dealIdField}
                placeholder="Enter deal ID"
                style="flex: 1;"
              />
              <ct-button onClick={advanceDeal}>Advance →</ct-button>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      stages: stageList,
      deals: dealView,
      totals,
      stageStats,
      totalForecast,
      openPipeline,
      lastAction,
    };
  },
);
