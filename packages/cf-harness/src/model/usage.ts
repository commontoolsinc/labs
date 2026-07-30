import {
  HARNESS_MODEL_USAGE_FIELDS,
  type HarnessModelUsage,
} from "./client.ts";

const finiteNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const recordValue = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const firstNumber = (
  record: Record<string, unknown>,
  names: readonly string[],
): number | undefined => {
  for (const name of names) {
    const value = finiteNonNegativeNumber(record[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * Normalizes usage returned by either the Responses API or Chat Completions.
 */
export const normalizeOpenAIUsage = (
  usage: Record<string, unknown> | undefined,
): HarnessModelUsage | undefined => {
  if (usage === undefined) return undefined;
  const inputDetails = recordValue(
    usage.input_tokens_details ?? usage.prompt_tokens_details,
  );
  const outputDetails = recordValue(
    usage.output_tokens_details ?? usage.completion_tokens_details,
  );
  const inputTokens = firstNumber(usage, ["input_tokens", "prompt_tokens"]);
  const cachedInputTokens = inputDetails === undefined
    ? undefined
    : firstNumber(inputDetails, ["cached_tokens"]);
  const cacheWriteTokens = inputDetails === undefined
    ? undefined
    : firstNumber(inputDetails, ["cache_write_tokens"]);
  const outputTokens = firstNumber(usage, [
    "output_tokens",
    "completion_tokens",
  ]);
  const reasoningTokens = outputDetails === undefined
    ? undefined
    : firstNumber(outputDetails, ["reasoning_tokens"]);
  const totalTokens = firstNumber(usage, ["total_tokens"]);
  const costUsd = firstNumber(usage, ["cost_usd"]);
  const normalized: HarnessModelUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/** Sums all reported fields while preserving "not reported" as absent. */
export const sumHarnessModelUsage = (
  entries: readonly (HarnessModelUsage | undefined)[],
): HarnessModelUsage | undefined => {
  const total: HarnessModelUsage = {};
  for (const field of HARNESS_MODEL_USAGE_FIELDS) {
    const values = entries.flatMap((entry) => {
      const value = entry?.[field];
      return value === undefined ? [] : [value];
    });
    if (values.length > 0) {
      total[field] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  return Object.keys(total).length > 0 ? total : undefined;
};

interface OpenAIModelTokenPrices {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const OPENAI_MODEL_TOKEN_PRICES: Record<string, OpenAIModelTokenPrices> = {
  "gpt-5.6": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 30,
  },
  "gpt-5.6-sol": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 30,
  },
  "gpt-5.6-terra": {
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15,
  },
  "gpt-5.6-luna": {
    inputPerMillionUsd: 1,
    cachedInputPerMillionUsd: 0.1,
    outputPerMillionUsd: 6,
  },
};

/**
 * Estimates GPT-5.6 token cost from the public OpenAI price schedule.
 *
 * Source: https://developers.openai.com/api/docs/models (verified 2026-07-30).
 *
 * Cache writes are priced at 1.25x uncached input. An estimate is withheld
 * unless the response reports both cache reads and writes, since treating
 * missing cache detail as zero would make a cache experiment misleading.
 */
export const estimateOpenAIModelUsageCostUsd = (
  model: string,
  usage: HarnessModelUsage | undefined,
): number | undefined => {
  const prices = OPENAI_MODEL_TOKEN_PRICES[model];
  if (
    prices === undefined || usage?.inputTokens === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheWriteTokens === undefined ||
    usage.outputTokens === undefined
  ) return undefined;
  const tokenCounts = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    ...(usage.reasoningTokens === undefined ? [] : [usage.reasoningTokens]),
    ...(usage.totalTokens === undefined ? [] : [usage.totalTokens]),
  ];
  if (
    tokenCounts.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) return undefined;
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens -
    usage.cacheWriteTokens;
  if (uncachedInputTokens < 0) return undefined;
  if (
    usage.totalTokens !== undefined &&
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) return undefined;
  if (
    usage.reasoningTokens !== undefined &&
    usage.reasoningTokens > usage.outputTokens
  ) return undefined;
  const longContextInputMultiplier = usage.inputTokens > 272_000 ? 2 : 1;
  const longContextOutputMultiplier = usage.inputTokens > 272_000 ? 1.5 : 1;
  return (
    (
        uncachedInputTokens * prices.inputPerMillionUsd +
        usage.cachedInputTokens * prices.cachedInputPerMillionUsd +
        usage.cacheWriteTokens * prices.inputPerMillionUsd * 1.25
      ) * longContextInputMultiplier +
    usage.outputTokens * prices.outputPerMillionUsd *
      longContextOutputMultiplier
  ) / 1_000_000;
};

export const withEstimatedOpenAIModelUsageCost = (
  model: string,
  usage: HarnessModelUsage | undefined,
): HarnessModelUsage | undefined => {
  const estimatedCostUsd = estimateOpenAIModelUsageCostUsd(model, usage);
  return usage === undefined || estimatedCostUsd === undefined
    ? usage
    : { ...usage, estimatedCostUsd };
};
