import { hc } from "@hono/hono/client";
import { AppType } from "@/app.ts";
import { Consumer } from "@commontools/memory";
import { Identity } from "@commontools/identity";
import { Memory, memory } from "@/routes/storage/memory.ts";
import env from "@/env.ts";
// Create a spellbook consumer.
const spellbook = Consumer.open({
  // Principal is currently derived from `sha256("spellbook")`
  as: await Identity.fromString(
    "MMrmta9413Wpz9zKcCfhnh5NGrLRo5KGK9GS+7ZPsgqs=",
  ),
  session: memory.session(),
});

const client = hc<AppType>(env.TOOLSHED_API_URL);
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
  if (typeof data.error === "string") {
    throw new MemoryError(data.error, data);
  }
  if ("cause" in data.error) {
    throw new MemoryError(data?.error?.cause?.message, data);
  } else {
    throw new MemoryError(data?.error?.message || "Unknown error", data);
  }
}

export async function getAllMemories(
  replica: string,
): Promise<Record<string, any>> {
  const result = await spellbook.mount(replica as Memory.DID).query({
    select: {
      _: {
        // <- any id
        "application/json": {
          _: {
            // <- any cause
            is: {},
          },
        },
      },
    },
  });

  if (result.error) {
    handleErrorResponse(result);
    return [];
  }

  console.log(result);
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

  const replicaData = Array.isArray(result.ok) ? result.ok[0] : result.ok;
  if (!replicaData || !replicaData[replica]) {
    return {};
  }

  const memoryMap: { [key: string]: any } = {};
  const memories = replicaData[replica];

  Object.entries(memories).forEach(([key, value]) => {
    if (!key.startsWith("of:")) return;

    const charmId = key.substring(3); // Remove 'of:' prefix
    const appJson = (value as any)["application/json"];
    if (!appJson) return;

    const [, firstMemory] = Object.entries(appJson)[0];
    const isValue = (firstMemory as any)?.is;
    if (isValue) {
      memoryMap[charmId] = isValue;
    }
  });

  return memoryMap;
}

export async function getMemory(key: string, replica: string): Promise<any> {
  const result = await spellbook.mount(replica as Memory.DID).query({
    select: {
      ["of:" + key]: {
        "application/json": {
          _: {
            // <- any cause
            is: {},
          },
        },
      },
    },
  });

  if (result.error) {
    throw handleErrorResponse(result);
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
  const memory = Array.isArray(result.ok) ? result.ok[0] : result.ok;
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
