import { assertEquals } from "@std/assert";
import {
  estimateOpenAIModelUsageCostUsd,
  normalizeOpenAIUsage,
  sumHarnessModelUsage,
} from "../src/model/usage.ts";

Deno.test("normalizeOpenAIUsage maps Responses cache and reasoning details", () => {
  assertEquals(
    normalizeOpenAIUsage({
      input_tokens: 2_000,
      input_tokens_details: {
        cached_tokens: 1_200,
        cache_write_tokens: 600,
      },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 2_300,
      cost_usd: 0.0123,
    }),
    {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
      reasoningTokens: 200,
      totalTokens: 2_300,
      costUsd: 0.0123,
    },
  );
});

Deno.test("normalizeOpenAIUsage maps Chat Completions token names", () => {
  assertEquals(
    normalizeOpenAIUsage({
      prompt_tokens: 1_500,
      prompt_tokens_details: {
        cached_tokens: 1_024,
        cache_write_tokens: 0,
      },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1_600,
    }),
    {
      inputTokens: 1_500,
      cachedInputTokens: 1_024,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40,
      totalTokens: 1_600,
    },
  );
});

Deno.test("sumHarnessModelUsage preserves absent fields", () => {
  assertEquals(
    sumHarnessModelUsage([
      { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
      { inputTokens: 20, cachedInputTokens: 12, outputTokens: 5 },
    ]),
    {
      inputTokens: 30,
      cachedInputTokens: 12,
      outputTokens: 8,
    },
  );
});

Deno.test("GPT-5.6 Terra estimates distinguish reads, writes, and output", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
    }),
    (
      200 * 2.5 +
      1_200 * 0.25 +
      600 * 2.5 * 1.25 +
      300 * 15
    ) / 1_000_000,
  );
});

Deno.test("cost estimate is withheld when cache detail is unavailable", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 2_000,
      outputTokens: 300,
    }),
    undefined,
  );
});

Deno.test("cost estimate is withheld for inconsistent cache detail", () => {
  assertEquals(
    estimateOpenAIModelUsageCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 800,
      cacheWriteTokens: 300,
      outputTokens: 100,
    }),
    undefined,
  );
});
