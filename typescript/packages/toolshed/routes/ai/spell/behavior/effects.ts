import { AppType } from "@/app.ts";
import { hc } from "hono/client";
import { handleResponse } from "@/lib/response.ts";

const client = hc<AppType>("http://localhost:8000/");

export async function generateText(query: Parameters<typeof client.api.ai.llm.$post>[0]["json"]) {
  const res = await client.api.ai.llm.$post({ json: query });
  return handleResponse<{ content: string, role: string }>(res).then(data => data.content);
}

export async function getAllBlobs(): Promise<string[]> {
  const res = await client.api.storage.blobby.get$();
  return handleResponse(res);
}

export async function getBlob(key: string): Promise<string> {
  const res = await client.api.storage.blobby.get$(key);
  return handleResponse(res);
}
