import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  collectCommand,
  type KeyToolDeps,
  requestCommand,
} from "./test-records-key.ts";
import {
  generateIdentity,
  type KeyDeliveryIdentity,
  recipientFingerprint,
  seal,
} from "./test-records-crypto.ts";

const KEY_TEXT = JSON.stringify({
  client_email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
  private_key: "pem",
  token_uri: "https://oauth2.googleapis.com/token",
  cf_username: "octocat",
});

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

// A single-member stored zip, the shape the artifact download serves.
function storedZip(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = [
    0x50,
    0x4b,
    0x03,
    0x04,
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(content.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
  ];
  const centralOffset = local.length + nameBytes.length + content.length;
  const central = [
    0x50,
    0x4b,
    0x01,
    0x02,
    ...u16le(20),
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(content.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(0),
  ];
  const eocd = [
    0x50,
    0x4b,
    0x05,
    0x06,
    ...u16le(0),
    ...u16le(0),
    ...u16le(1),
    ...u16le(1),
    ...u32le(central.length + nameBytes.length),
    ...u32le(centralOffset),
    ...u16le(0),
  ];
  return new Uint8Array([
    ...local,
    ...nameBytes,
    ...content,
    ...central,
    ...nameBytes,
    ...eocd,
  ]);
}

describe("test-records-key", () => {
  let home: string;
  let deps: KeyToolDeps;
  let urls: string[];

  function withFetch(fetchImpl: typeof fetch, token = "gh-token"): void {
    deps = {
      env: (name) => name === "XDG_CONFIG_HOME" ? home : undefined,
      fetchImpl: ((input: URL | RequestInfo, init?: RequestInit) => {
        urls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return fetchImpl(input, init);
      }) as typeof fetch,
      githubToken: () => Promise.resolve(token),
    };
  }

  async function storeIdentity(): Promise<KeyDeliveryIdentity> {
    const identity = await generateIdentity();
    await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
    await Deno.writeTextFile(
      join(home, "common-fabric", "test-records-identity.json"),
      JSON.stringify(identity),
    );
    return identity;
  }

  beforeEach(async () => {
    home = await Deno.makeTempDir({ prefix: "test-records-key-" });
    urls = [];
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  });

  describe("requestCommand()", () => {
    it("stores an identity with owner-only permissions and dispatches", async () => {
      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "octocat" }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        }) as typeof fetch,
      );

      await requestCommand(deps);

      const path = join(home, "common-fabric", "test-records-identity.json");
      const identity = JSON.parse(await Deno.readTextFile(path));
      expect(identity.recipient.startsWith("cfr1")).toBe(true);
      expect(Deno.statSync(path).mode! & 0o777).toBe(0o600);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("keeps an existing identity and prints instructions without a token", async () => {
      const identity = await storeIdentity();
      withFetch(
        (() => {
          throw new Error("no request expected");
        }) as unknown as typeof fetch,
      );
      deps.githubToken = () => Promise.resolve(undefined);

      await requestCommand(deps);

      const stored = JSON.parse(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-identity.json"),
        ),
      );
      expect(stored.recipient).toBe(identity.recipient);
      expect(urls).toEqual([]);
    });

    it("falls back to instructions when the dispatch is refused", async () => {
      await storeIdentity();
      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "octocat" }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }) as typeof fetch,
      );

      await requestCommand(deps);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });
  });

  describe("collectCommand()", () => {
    it("throws without a stored identity", async () => {
      withFetch(fetch);
      await expect(collectCommand(deps)).rejects.toThrow(
        "no delivery identity",
      );
    });

    it("downloads, opens, validates, and installs the delivered key", async () => {
      const identity = await storeIdentity();
      const fingerprint = await recipientFingerprint(identity.recipient);
      const sealed = await seal(
        identity.recipient,
        new TextEncoder().encode(KEY_TEXT),
      );
      const zip = storedZip(
        `${fingerprint}.sealed`,
        new TextEncoder().encode(JSON.stringify(sealed)),
      );

      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "OctoCat" }), {
                status: 200,
              }),
            );
          }
          if (url.includes("/runs?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  workflow_runs: [{ id: 42, status: "completed" }],
                }),
                { status: 200 },
              ),
            );
          }
          if (url.includes("/artifacts?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  artifacts: [{
                    id: 7,
                    name: `test-records-key-${fingerprint}`,
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          if (url.endsWith("/zip")) {
            return Promise.resolve(
              new Response(zip as unknown as BodyInit, { status: 200 }),
            );
          }
          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }) as typeof fetch,
      );

      expect(await collectCommand(deps)).toBe(0);

      const installed = join(home, "common-fabric", "test-records-key.json");
      expect(await Deno.readTextFile(installed)).toBe(KEY_TEXT);
      expect(Deno.statSync(installed).mode! & 0o777).toBe(0o600);
      expect(urls.some((line) => line.includes("actor=OctoCat"))).toBe(true);
    });

    it("asks to retry while the minting run is still going", async () => {
      await storeIdentity();
      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "octocat" }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                workflow_runs: [{ id: 42, status: "in_progress" }],
              }),
              { status: 200 },
            ),
          );
        }) as typeof fetch,
      );

      expect(await collectCommand(deps)).toBe(1);
    });

    it("refuses a key minted for someone else", async () => {
      const identity = await storeIdentity();
      const fingerprint = await recipientFingerprint(identity.recipient);
      const sealed = await seal(
        identity.recipient,
        new TextEncoder().encode(KEY_TEXT),
      );
      const zip = storedZip(
        `${fingerprint}.sealed`,
        new TextEncoder().encode(JSON.stringify(sealed)),
      );

      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "someone-else" }), {
                status: 200,
              }),
            );
          }
          if (url.includes("/runs?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  workflow_runs: [{ id: 42, status: "completed" }],
                }),
                { status: 200 },
              ),
            );
          }
          if (url.includes("/artifacts?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  artifacts: [{
                    id: 7,
                    name: `test-records-key-${fingerprint}`,
                  }],
                }),
                { status: 200 },
              ),
            );
          }
          if (url.endsWith("/zip")) {
            return Promise.resolve(
              new Response(zip as unknown as BodyInit, { status: 200 }),
            );
          }
          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }) as typeof fetch,
      );

      await expect(collectCommand(deps)).rejects.toThrow("minted for");
    });

    it("throws when no completed run delivered to this identity", async () => {
      await storeIdentity();
      withFetch(
        ((input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ login: "octocat" }), {
                status: 200,
              }),
            );
          }
          if (url.includes("/runs?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  workflow_runs: [{ id: 42, status: "completed" }],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ artifacts: [] }), { status: 200 }),
          );
        }) as typeof fetch,
      );

      await expect(collectCommand(deps)).rejects.toThrow(
        "no completed minting run",
      );
    });
  });
});
