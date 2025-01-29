import { AppType } from "@/app.ts";
import { hc } from "hono/client";

const client = hc<AppType>("http://localhost:8000/");
export interface BlobOptions {
  allWithData?: boolean;
  prefix?: string;
  search?: string;
  keys?: string;
}

export async function getAllBlobs(
  options: BlobOptions = {},
): Promise<string[] | { [id: string]: any }> {
  const query: Record<string, string> = {
    all: "true",
  };

  if (options.allWithData) query.allWithData = "true";
  if (options.prefix) query.prefix = options.prefix;
  if (options.search) query.search = options.search;
  if (options.keys) query.keys = options.keys;

  const res = await client.api.storage.blobby.$get({ query });
  const data = await res.json();
  if ("error" in data) {
    throw new Error(data.error);
  }
  return data.blobs || data;
}

export async function getBlob(key: string): Promise<unknown> {
  const res = await client.api.storage.blobby[":key"].$get({ param: { key } });
  const data = await res.json() as any;

  if ("error" in data) {
    throw new Error(data.error);
  }

  return data;
}
