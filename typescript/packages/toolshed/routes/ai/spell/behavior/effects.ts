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
    json: {
      cmd: "/memory/query",
      iss: "did:web:common.tools",
      sub: replica,
      args: {
        select: {
          _: {
            "application/json": {
              is: {},
            },
          },
        },
      },
    },
  });
  const data = await res.json();
  if ("error" in data) {
    throw data.error;
  }
  const rawMemories: { the?: string; of?: string; is?: any }[] =
    Array.isArray(data.ok) ? data.ok : [data.ok];
  const memories: { the: string; of: string; is: any }[] = rawMemories
    .filter((m) => m.the && m.of && m.is)
    .map((m: any) => ({
      the: m.the,
      of: m.of,
      is: m.is,
    }));

  const memoryMap: { [key: string]: any } = {};
  memories.forEach((memory) => {
    // FIXME(ja): using jumble can result in memory.is == {}
    const value = memory.is?.value?.argument;
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
    throw data.error;
  }
  return data.blobs || data;
}

export async function getBlob(key: string): Promise<unknown> {
  const res = await client.api.storage.blobby[":key"].$get({ param: { key } });
  const data = (await res.json()) as any;

  if ("error" in data) {
    throw data.error;
  }

  return data;
}
