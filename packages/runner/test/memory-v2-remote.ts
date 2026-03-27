import type {
  MemorySpace,
  StorableValue,
  URI,
} from "@commontools/memory/interface";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import type { Server as MemoryV2Server } from "@commontools/memory/v2/server";

type EmulatedStorageManagerLike = {
  server(): MemoryV2Server;
};

export const writeRemoteValues = async (
  storageManager: unknown,
  space: MemorySpace,
  docs: readonly { id: URI; value: StorableValue }[],
): Promise<void> => {
  const candidate = storageManager as { server?: () => MemoryV2Server };
  if (typeof candidate.server !== "function") {
    throw new Error("Expected a memory/v2 emulated storage manager");
  }
  const emulated = candidate as EmulatedStorageManagerLike;
  const client = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(emulated.server()),
  });

  try {
    const session = await client.mount(space);
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: docs.map(({ id, value }) => ({
        op: "set" as const,
        id,
        value: { value },
      })),
    });
  } finally {
    await client.close();
  }
};
