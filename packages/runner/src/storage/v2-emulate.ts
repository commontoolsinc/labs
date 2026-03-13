import type {
  MemorySpace,
  StorableDatum,
  URI,
} from "@commontools/memory/interface";
import { iterate as iterateFacts } from "@commontools/memory/fact";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import * as MemoryV2Server from "@commontools/memory/v2/server";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

const DOCUMENT_MIME = "application/json" as const;

class EmulatedSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(space);
    return { client, session };
  }
}

const toStoredDocument = (value: StorableDatum) => {
  if (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    ("value" in value || "source" in value)
  ) {
    return {
      ...("value" in value
        ? { value: (value as { value: unknown }).value }
        : {}),
      ...("source" in value &&
          (value as { source?: unknown }).source !== undefined
        ? { source: (value as { source?: unknown }).source }
        : {}),
    } as StorableDatum;
  }
  return { value } as StorableDatum;
};

export class EmulatedStorageManager extends StorageManager {
  #server: MemoryV2Server.Server;
  #seedLocalSeq = 1;

  static emulate(
    options: Omit<Options, "address">,
  ): EmulatedStorageManager {
    const server = new MemoryV2Server.Server();
    return new this(
      {
        ...options,
        address: new URL("memory://"),
      },
      new EmulatedSessionFactory(server),
      server,
    );
  }

  private constructor(
    options: Options,
    sessionFactory: SessionFactory,
    server: MemoryV2Server.Server,
  ) {
    super(options, sessionFactory);
    this.#server = server;
  }

  override async close(): Promise<void> {
    await super.close();
    await this.#server.close();
  }

  session() {
    return {
      mount: (space: MemorySpace) => ({
        transact: async ({ changes }: { changes: unknown }) => {
          const client = await MemoryV2Client.connect({
            transport: MemoryV2Client.loopback(this.#server),
          });
          try {
            const session = await client.mount(space);
            const operations = [...iterateFacts(changes as any)]
              .filter((fact) => fact.the === DOCUMENT_MIME)
              .map((fact) =>
                fact.is === undefined
                  ? { op: "delete" as const, id: fact.of as URI }
                  : {
                    op: "set" as const,
                    id: fact.of as URI,
                    value: toStoredDocument(fact.is as StorableDatum) as any,
                  }
              );

            if (operations.length === 0) {
              return { ok: {} };
            }

            await session.transact({
              localSeq: this.#seedLocalSeq++,
              reads: { confirmed: [], pending: [] },
              operations,
            });
            return { ok: {} };
          } finally {
            await client.close();
          }
        },
      }),
    };
  }
}
