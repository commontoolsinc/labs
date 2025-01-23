import { AppType } from "@/app.ts";
import { hc } from "hono/client";
import { handleResponse } from "@/lib/response.ts";

const client = hc<AppType>("http://localhost:8000/");

export async function getAllBlobs(): Promise<string[]> {
  const res = await client.api.storage.blobby.$get({ query: { all: "true" } });
  const data = await res.json();
  if ("error" in data) {
    throw new Error(data.error);
  }
  return data.blobs;
}

export async function getBlob(key: string): Promise<unknown> {
  const res = await client.api.storage.blobby[":key"].$get({ param: { key } });
  const data = await res.json() as unknown;

  if ("error" in data) {
    throw new Error(data.error);
  }

  return data;
}
