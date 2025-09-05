import app from "@/app.ts";
import { hc } from "@hono/hono/client";
import env from "@/env.ts";
import { LLMContent } from "@commontools/llm/types";
// NOTE(jake): Ideally this would be exposed via the hono client, but I wasn't
// able to get it all wired up. Importing the route definition is fine for now.
import type { GetModelsRouteQueryParams } from "@/routes/ai/llm/llm.routes.ts";

const client = hc<typeof app>(env.API_URL);

export async function listAvailableModels({
  capability,
  task,
  search,
}: GetModelsRouteQueryParams) {
  const res = await client.api.ai.llm.models.$get({
    query: {
      search,
      capability,
      task,
    },
  });
  return res.json();
}

export async function generateText(
  query: Parameters<typeof client.api.ai.llm.$post>[0]["json"],
): Promise<LLMContent> {
  const res = await client.api.ai.llm.$post({ json: query });
  const data = await res.json();

  if ("error" in data) {
    throw new Error(data.error);
  }

  if ("type" in data && data.type === "json") {
    return data.body.content;
  }

  if ("content" in data) {
    // bf: this is actually the case that runs, even if the types disagree
    // no idea why
    return (data as Record<string, LLMContent>).content;
  }

  throw new Error("Unexpected response from LLM server");
}
