import { hc } from "hono/client";
import { AppType } from "@/app.ts";
import { Memory } from "@commontools/memory";

const client = hc<AppType>("http://localhost:8000/");
export interface BlobOptions {
  allWithData?: boolean;
  prefix?: string;
  search?: string;
  keys?: string;
}

export class MemoryError extends Error {
  context: any;

  constructor(message: string, context?: any) {
    super(message);
    this.name = "MemoryError";
    this.context = context;
  }
}

function handleErrorResponse(data: any) {
  if ("cause" in data.error) {
    throw new MemoryError(data?.error?.cause?.message, data);
  } else {
    throw new MemoryError(data?.error?.message, data);
  }
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
          _: { // <- any id
            "application/json": {
              "_": { // <- any cause
                "is": {},
              },
            },
          },
        },
      },
    },
  });
  const data = await res.json();
  if ("error" in data) {
    handleErrorResponse(data);
    return [];
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

export async function getMemory(
  key: string,
  replica: string,
): Promise<any> {
  const res = await client.api.storage.memory.$post({
    json: {
      cmd: "/memory/query",
      iss: "did:web:common.tools",
      sub: replica,
      args: {
        select: {
          ["of:" + key]: {
            "application/json": {
              "_": { // <- any cause
                "is": {},
              },
            },
          },
        },
      },
    },
  });
  const data = await res.json();
  if ("error" in data) {
    throw handleErrorResponse(data);
  }

  // format
  // {
  //   ok: {
  //     "did:key:replica": {
  //       "of:charmId": {
  //         "application/json": {
  //           "causeId": {
  //             "is": {
  //               "value": {...}
  //             }
  //           }
  //         }
  //       }
  //     }
  //   }
  // }
  //
  //
  const memory = Array.isArray(data.ok) ? data.ok[0] : data.ok;
  const memoryData = memory[replica]["of:" + key]["application/json"];
  const [, firstValue] = Object.entries(memoryData)[0];
  return (firstValue as any)?.is;
}

export async function getAllBlobs<T extends unknown>(
  options: BlobOptions = {},
): Promise<string[] | { [id: string]: T }> {
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
    throw handleErrorResponse(data);
  }
  return data.blobs || data;
}

export async function getBlob<T extends unknown>(key: string): Promise<T> {
  const res = await client.api.storage.blobby[":key"].$get({ param: { key } });
  const data = (await res.json()) as any;

  if ("error" in data) {
    throw handleErrorResponse(data);
  }

  return data;
}
