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

  console.log(data);
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
  //         },
  //       "of:charmId2": {
  //         "application/json": {
  //           "causeId": {
  //             "is": {
  //               "value": {...}
  //             }
  //           }
  //         }
  //       }
  //       "of:charmId3": {
  //         "application/json": {
  //           "causeId": {
  //             "is": {
  //               "value": {...}
  //             }
  //           }
  //         }
  //       }...
  //     }
  //   }
  // }
  //

  const replicaData = Array.isArray(data.ok) ? data.ok[0] : data.ok;
  if (!replicaData || !replicaData[replica]) {
    return {};
  }

  const memoryMap: { [key: string]: any } = {};
  const memories = replicaData[replica];

  Object.entries(memories).forEach(([key, value]) => {
    if (!key.startsWith('of:')) return;

    const charmId = key.substring(3); // Remove 'of:' prefix
    const appJson = (value as any)['application/json'];
    if (!appJson) return;

    const [, firstMemory] = Object.entries(appJson)[0];
    const isValue = (firstMemory as any)?.is;
    if (isValue) {
      memoryMap[charmId] = isValue;
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
