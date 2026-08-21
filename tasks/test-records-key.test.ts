import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  collectCommand,
  type KeyToolDeps,
  requestCommand,
  setupCommand,
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

/**
 * A run as the API lists it. `named: false` is a run of a workflow
 * version whose run name does not carry the recipient, which is what the
 * delivery artifact has to identify instead.
 */
function mintRun(
  recipient: string,
  run: {
    id?: number;
    status?: string;
    conclusion?: string;
    created_at?: string;
    named?: boolean;
    actor?: string;
  } = {},
): Record<string, unknown> {
  const id = run.id ?? 42;
  return {
    id,
    status: run.status ?? "completed",
    conclusion: run.conclusion ?? "success",
    created_at: run.created_at ?? "2026-08-21T02:00:00Z",
    html_url: `https://github.com/commontoolsinc/labs/actions/runs/${id}`,
    display_title: run.named === false
      ? "Test Records Mint"
      : `Mint reporting key for octocat (${recipient})`,
    actor: { login: run.actor ?? "octocat" },
  };
}

interface StubOptions {
  login?: string;
  /** One page of runs per listing call; the last repeats. */
  runPages?: Record<string, unknown>[][];
  artifacts?: { id: number; name: string; expired?: boolean }[];
  artifactStatus?: number;
  zip?: Uint8Array;
  zipStatus?: number;
  dispatchStatus?: number;
  dispatchDate?: string;
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
      pause: () => Promise.resolve(),
    };
  }

  function withStub(options: StubOptions, token = "gh-token"): void {
    let page = 0;
    withFetch(
      ((input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ login: options.login ?? "octocat" }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/dispatches")) {
          const headers = options.dispatchDate !== undefined
            ? { date: options.dispatchDate }
            : undefined;
          return Promise.resolve(
            new Response(null, {
              status: options.dispatchStatus ?? 204,
              ...(headers !== undefined ? { headers } : {}),
            }),
          );
        }
        if (url.includes("/runs?")) {
          const pages = options.runPages ?? [[]];
          const runs = pages[Math.min(page++, pages.length - 1)]!;
          return Promise.resolve(
            new Response(JSON.stringify({ workflow_runs: runs }), {
              status: 200,
            }),
          );
        }
        if (url.includes("/artifacts?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ artifacts: options.artifacts ?? [] }),
              { status: options.artifactStatus ?? 200 },
            ),
          );
        }
        if (url.endsWith("/zip")) {
          return Promise.resolve(
            new Response(
              (options.zip ?? new Uint8Array()) as unknown as BodyInit,
              { status: options.zipStatus ?? 200 },
            ),
          );
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }) as typeof fetch,
      token,
    );
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

  /** The delivery a successful run publishes for an identity. */
  async function delivery(
    identity: KeyDeliveryIdentity,
    keyText = KEY_TEXT,
  ): Promise<{ artifacts: { id: number; name: string }[]; zip: Uint8Array }> {
    const fingerprint = await recipientFingerprint(identity.recipient);
    const sealed = await seal(
      identity.recipient,
      new TextEncoder().encode(keyText),
    );
    return {
      artifacts: [{ id: 7, name: `test-records-key-${fingerprint}` }],
      zip: storedZip(
        `${fingerprint}.sealed`,
        new TextEncoder().encode(JSON.stringify(sealed)),
      ),
    };
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
      withStub({});

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
      withStub({ dispatchStatus: 403 });

      await requestCommand(deps);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });
  });

  describe("collectCommand()", () => {
    it("throws without a stored identity", async () => {
      withStub({});
      await expect(collectCommand(deps)).rejects.toThrow(
        "No delivery identity",
      );
    });

    it("downloads, opens, validates, and installs the delivered key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        login: "OctoCat",
        runPages: [[mintRun(identity.recipient)]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);

      const installed = join(home, "common-fabric", "test-records-key.json");
      expect(await Deno.readTextFile(installed)).toBe(KEY_TEXT);
      expect(Deno.statSync(installed).mode! & 0o777).toBe(0o600);
    });

    it("asks to retry while the minting run is still going", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { status: "in_progress" })]],
      });

      expect(await collectCommand(deps)).toBe(1);
    });

    it("names the run that failed", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { conclusion: "failure" })]],
      });

      await expect(collectCommand(deps)).rejects.toThrow("finished as failure");
    });

    it("throws when no run is minting for this recipient", async () => {
      await storeIdentity();
      withStub({
        runPages: [[mintRun("cfr1someone-else", { actor: "someone-else" })]],
      });

      await expect(collectCommand(deps)).rejects.toThrow("No minting run");
    });

    it("identifies a run that does not name the recipient by its delivery", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient, { named: false })]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("passes over a delivery-less run someone else dispatched", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[
          mintRun("cfr1someone-else", { id: 9, actor: "someone-else" }),
          mintRun(identity.recipient, { named: false }),
        ]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/runs/9/artifacts"))).toBe(
        false,
      );
    });

    it("refuses a key minted for someone else", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        login: "someone-else",
        runPages: [[mintRun(identity.recipient)]],
        ...published,
      });

      await expect(collectCommand(deps)).rejects.toThrow("minted for");
    });

    it("throws when the run published no delivery", async () => {
      const identity = await storeIdentity();
      withStub({ runPages: [[mintRun(identity.recipient)]], artifacts: [] });

      await expect(collectCommand(deps)).rejects.toThrow(
        "published no delivery",
      );
    });

    it("names the status when the artifact listing fails", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifactStatus: 500,
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Listing the artifacts of run 42 failed: HTTP 500",
      );
    });

    it("throws when the delivery download fails", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: published.artifacts,
        zipStatus: 410,
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Downloading the delivery failed",
      );
    });

    it("throws when the delivery zip holds no sealed key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: published.artifacts,
        zip: storedZip("readme.txt", new TextEncoder().encode("hi")),
      });

      await expect(collectCommand(deps)).rejects.toThrow("holds no sealed key");
    });

    it("throws without any usable token", async () => {
      await storeIdentity();
      withStub({});
      deps.githubToken = () => Promise.resolve(undefined);
      await expect(collectCommand(deps)).rejects.toThrow(
        "A GitHub token is needed",
      );
    });
  });

  describe("setupCommand()", () => {
    /** A workstation whose login shell is zsh, profile and all. */
    function withShell(): string {
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      return join(home, ".zshrc");
    }

    it("dispatches, waits for the run, installs, and exports the key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [
          [],
          [mintRun(identity.recipient, { status: "queued" })],
          [mintRun(identity.recipient, { status: "in_progress" })],
          [mintRun(identity.recipient)],
        ],
        ...published,
      });
      const profile = withShell();

      expect(await setupCommand(deps)).toBe(0);

      const installed = join(home, "common-fabric", "test-records-key.json");
      expect(await Deno.readTextFile(installed)).toBe(KEY_TEXT);
      expect(await Deno.readTextFile(profile)).toContain(
        'export CF_TEST_RECORDS_KEY_FILE="$HOME/common-fabric/' +
          'test-records-key.json"',
      );
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("follows a run that does not name the recipient to its delivery", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        dispatchDate: "Fri, 21 Aug 2026 01:00:00 GMT",
        runPages: [
          [mintRun(identity.recipient, {
            named: false,
            status: "in_progress",
            conclusion: undefined,
          })],
          [mintRun(identity.recipient, { named: false })],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("keeps watching when the dispatch is refused", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        dispatchStatus: 403,
        runPages: [[], [mintRun(identity.recipient)]],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("ignores a run that predates the dispatch", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        dispatchDate: "Fri, 21 Aug 2026 03:00:00 GMT",
        runPages: [
          [mintRun(identity.recipient, {
            id: 1,
            created_at: "2026-08-21T02:00:00Z",
          })],
          [
            mintRun(identity.recipient, {
              id: 2,
              created_at: "2026-08-21T03:00:01Z",
            }),
            mintRun(identity.recipient, {
              id: 1,
              created_at: "2026-08-21T02:00:00Z",
            }),
          ],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/runs/2/artifacts"))).toBe(
        true,
      );
      expect(urls.some((line) => line.includes("/runs/1/artifacts"))).toBe(
        false,
      );
    });

    it("names the run that failed instead of waiting on it", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { conclusion: "failure" })]],
      });

      await expect(setupCommand(deps)).rejects.toThrow("finished as failure");
    });

    it("exports the installed key rather than minting a second one", async () => {
      await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      withStub({});
      const profile = withShell();

      expect(await setupCommand(deps)).toBe(0);

      expect(await Deno.readTextFile(profile)).toContain(
        "CF_TEST_RECORDS_KEY_FILE",
      );
      expect(urls).toEqual([]);
    });

    it("mints a replacement when asked to rotate", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await setupCommand(deps, { rotate: true })).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("throws without any usable token", async () => {
      withStub({});
      deps.githubToken = () => Promise.resolve(undefined);
      await expect(setupCommand(deps)).rejects.toThrow(
        "A GitHub token is needed",
      );
    });
  });
});
