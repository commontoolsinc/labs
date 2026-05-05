import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import createApp from "@/lib/create-app.ts";
import router from "./blobs.index.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import env from "@/env.ts";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-bytes";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getJsonEncodingConfig,
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
} from "@commonfabric/data-model/json-encoding";
import {
  getDataModelConfig,
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp()
  .route("/", memory)
  .route("/", router);

const withUnifiedJsonEncoding = <T>(fn: () => T): T => {
  const previous = getJsonEncodingConfig();
  const previousDataModel = getDataModelConfig();
  setDataModelConfig(true);
  setJsonEncodingConfig(true);
  try {
    return fn();
  } finally {
    if (previousDataModel) {
      setDataModelConfig(true);
    } else {
      resetDataModelConfig();
    }
    if (previous) {
      setJsonEncodingConfig(true);
    } else {
      resetJsonEncodingConfig();
    }
  }
};

const encodeBlobPayload = (payload: { type: string; body: FabricBytes }) =>
  withUnifiedJsonEncoding(() => encodeMemoryBoundary(payload));

describe("Blob Routes", () => {
  it("stores and serves a FabricBytes blob by content id", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route");
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const contents = {
      type: "image/gif",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.gif`,
    });

    const get = await app.request(`/${identity.did()}/blobs/${hash}.png`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/gif");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("stores blob contents as a cell document value", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-cell");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const contents = {
      type: "image/png",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const cid = `cid:${id}` as const;
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.png`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);

    const document = await memoryServer.readDocument(
      identity.did(),
      cid,
      { unifiedJsonEncoding: true },
    );
    expect(document?.value).toEqual(contents);

    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const runtime = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        address: new URL("/api/storage/memory", base),
      }),
      experimental: {
        modernDataModel: true,
        unifiedJsonEncoding: true,
      },
    });

    try {
      const provider = runtime.storageManager.open(identity.did());
      const sync = await provider.sync(cid, {
        path: [],
        schema: false,
      });
      expect(sync).toEqual({ ok: {} });

      const cell = runtime.getCellFromLink<{
        type: string;
        body: FabricBytes;
      }>({
        id: cid,
        path: [],
        space: identity.did(),
      });
      await cell.sync();
      await runtime.storageManager.synced();

      const value = cell.get();
      expect(value.type).toBe("image/png");
      expect(value.body).toBeTruthy();
      expect(value.body.constructor.name).toBe("FabricBytes");
      expect((await post.json()).url).toBe(`blobs/${hash}.png`);
    } finally {
      await runtime.dispose();
      await server.shutdown();
    }
  });

  it("returns 404 for an absent blob", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route-404");
    const get = await app.request(`/${identity.did()}/blobs/missing.png`);
    expect(get.status).toBe(404);
  });

  it("rejects invalid blob payloads", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route-400");
    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image/gif", body: "not-bytes" }),
    });
    expect(post.status).toBe(400);
  });
});
