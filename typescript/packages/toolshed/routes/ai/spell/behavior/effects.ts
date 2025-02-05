import { AppType } from "@/app.ts";
import { hc } from "hono/client";

const client = hc<AppType>("http://localhost:8000/");
export interface BlobOptions {
  allWithData?: boolean;
  prefix?: string;
  search?: string;
  keys?: string;
}


export async function getAllMemories(
  replica: string,
): Promise<Record<string, any>> {
  const res = await client.api.storage.memory.$post({
    json: { [replica]: { the: "application/json" } },
  });
  const data = await res.json();
  if ("error" in data) {
    throw new Error(data.error);
  }
  const memories: { the: string; of: string; is: any }[] = data.ok || data;

  const memoryMap: { [key: string]: any } = {};
  memories.forEach((memory) => {
    const value = memory.is?.value.argument;
    if (value) {
      memoryMap[memory.of] = value;
    }
  });
  return memoryMap;
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
