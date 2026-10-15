import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";

import type { JSONSchema } from "../src/builder/types.ts";
import { encodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// Fresh identity per run: the server derives the on-disk cell-db file from the
// db id, so a fixed passphrase would reuse a stale db across runs.
const signer = await Identity.fromPassphrase(
  `sqlite cf-link foreign source ${crypto.randomUUID()}`,
);
const space = signer.did();

// The linked document carries a label of its own, so linking it into the
// query's labeled result needs that label from the source's stored metadata.
const imageSchema = {
  type: "object",
  properties: {
    bytes: { type: "FabricBytes" },
    mediaType: { type: "string" },
  },
  required: ["bytes", "mediaType"],
  ifc: { confidentiality: [space] },
} as const satisfies JSONSchema;

const ownerLabeled = {
  type: "string",
  sqlType: "text",
  ifc: { confidentiality: [space] },
} as const;

const rowSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    image_cf_link: {
      asCell: ["cell"],
      type: "object",
      properties: {
        bytes: { type: "FabricBytes" },
        mediaType: { type: "string" },
      },
    },
  },
} as const satisfies JSONSchema;

type QueryState = {
  pending?: boolean;
  error?: unknown;
  result?: Array<{ image_cf_link?: unknown }>;
};

describe("sqlite-cf-link-foreign-source", () => {
  // Two runtimes with separate replicas over one memory server: the defect
  // shows only when the linked document exists on the server but has never
  // been in the reading runtime's replica.
  let server: MemoryV2Server.Server;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
  });

  afterEach(async () => {
    // Both schedulers stop before either runtime is torn down, since either
    // can still be answering a load the other started.
    await Promise.allSettled([writer.settled(), reader.settled()]);
    reader.scheduler.dispose();
    writer.scheduler.dispose();
    await reader.dispose();
    await writer.dispose();
    await server.close();
  });

  /**
   * Writes a labeled image document in `writer` and a row linking it into a
   * labeled table, and returns the table's db reference.
   */
  async function seedLinkedImage(): Promise<SqliteDbRef> {
    const written = await writer.editWithRetry((tx) => {
      const cell = writer.getCell(space, "image-1", imageSchema, tx);
      cell.set({
        bytes: new FabricBytes(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])),
        mediaType: "image/jpeg",
      });
      writer.prepareTxForCommit(tx);
      return encodeCfLinkValue(cell);
    });
    expect(written.error).toBeUndefined();

    const db: SqliteDbRef = {
      id: `of:images-${crypto.randomUUID()}`,
      owner: space,
      tables: {
        images: table({ id: ownerLabeled, image_cf_link: ownerLabeled }),
      },
    };
    const seedTx = writer.edit();
    seedTx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO images (id, image_cf_link) VALUES (?, ?)",
      params: ["1", written.ok!] as SqliteParamsWire,
    });
    expect((await seedTx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    return db;
  }

  /** Runs a typed query of `db` in `runtime` and returns its settled state. */
  async function queryImages(
    runtime: Runtime,
    db: SqliteDbRef,
  ): Promise<{ state: QueryState; image: unknown }> {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const pattern = cf.pattern(() =>
      cf.sqliteQuery({
        db,
        sql: "SELECT id, image_cf_link FROM images",
        reactOn: db,
        rowSchema,
        scope: "session",
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      `images-query-${crypto.randomUUID()}`,
      pattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, pattern, {}, resultCell);
    // The query runs only while something demands its result; the demand is
    // held across the settle so the query's write-back lands before the read.
    result.sink(() => {});
    await tx.commit().settled;
    await runtime.settled();

    const state = result.get() as QueryState;
    const typed = result.asSchema(
      {
        type: "object",
        properties: { result: { type: "array", items: rowSchema } },
      } as const satisfies JSONSchema,
    ).get() as QueryState;
    return { state, image: typed.result?.[0]?.image_cf_link };
  }

  it("returns a row whose link resolves when the same runtime wrote the linked document", async () => {
    const db = await seedLinkedImage();

    const { state, image } = await queryImages(writer, db);

    expect(state.error).toBeUndefined();
    expect(state.pending).toBe(false);
    expect(state.result).toHaveLength(1);
    expect(isCell(image)).toBe(true);
  });

  it("returns a row whose link resolves when another runtime wrote the linked document", async () => {
    const db = await seedLinkedImage();

    const { state, image } = await queryImages(reader, db);

    expect(state.error).toBeUndefined();
    expect(state.pending).toBe(false);
    expect(state.result).toHaveLength(1);
    expect(isCell(image)).toBe(true);
    const bytes = (image as { key(k: "bytes"): { get(): unknown } })
      .key("bytes").get();
    expect(bytes).toBeInstanceOf(FabricBytes);
  });
});
