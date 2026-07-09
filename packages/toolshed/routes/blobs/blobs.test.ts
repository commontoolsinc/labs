import { afterAll, afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import createApp from "@/lib/create-app.ts";
import router from "./blobs.index.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import env from "@/env.ts";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { JsonEncodingContext } from "@commonfabric/data-model/codec-json";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type FabricValue } from "@commonfabric/data-model/fabric-value";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp()
  .route("/", memory)
  .route("/", router);

const encodeBlobPayload = (payload: { type: string; body: FabricBytes }) =>
  encodeMemoryBoundary(payload);

const blobUploadEncoding = new JsonEncodingContext();

describe("Blob Routes", () => {
  afterEach(async () => {
    await memoryServer.flushSessions();
  });

  afterAll(async () => {
    // The toolshed `memoryServer` is a module-level singleton constructed when
    // memory.ts is imported. Deno isolates each test file's module graph, so
    // this instance is owned by this file alone. Closing it releases its SQLite
    // handles, engine map, and refresh timer.
    await memoryServer.close();
  });

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

  it("accepts blob upload encoding from an explicit codec, without ambient data-model flags", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-explicit-codec",
    );
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
      body: blobUploadEncoding.encode(contents as FabricValue),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.gif`,
    });

    const get = await app.request(`/${identity.did()}/blobs/${hash}.gif`);
    expect(get.status).toBe(200);
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
    );
    expect(document?.value).toEqual(contents);

    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(
      `http://${server.addr.hostname}:${server.addr.port}`,
    );
    const runtime = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        memoryHost: new URL(base),
      }),
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

  it("returns 400 for a malformed blob name", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-bad-name",
    );
    const get = await app.request(`/${identity.did()}/blobs/.png`);
    expect(get.status).toBe(400);
  });

  it("falls back to the MIME default for invalid upload suffixes", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-suffix",
    );
    const contents = {
      type: "image/png",
      body: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.toolonggg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });

    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.png`,
    });
  });

  it("rejects oversized blob uploads before decoding", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-too-large",
    );

    const post = await app.request(`/${identity.did()}/blobs/image.png`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
      body: "not decoded",
    });

    expect(post.status).toBe(413);
  });

  it("serves unsafe blob MIME types as octet-stream", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-unsafe-mime",
    );
    const bytes = new TextEncoder().encode("<script>alert(1)</script>");
    const contents = {
      type: "text/html",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/page.html`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);

    const get = await app.request(`/${identity.did()}/blobs/${hash}.html`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
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
