import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import createApp from "@/lib/create-app.ts";
import router from "./blobs.index.ts";
import env from "@/env.ts";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-bytes";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
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

const app = createApp().route("/", router);

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
