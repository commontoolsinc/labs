import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  collectCommand,
  defaultDeps,
  defaultGithubToken,
  INTERRUPT_NOTICE,
  type KeyToolDeps,
  requestCommand,
  runCli,
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
  loginStatus?: number;
  /** One page of runs per listing call; the last repeats. */
  runPages?: Record<string, unknown>[][];
  runsStatus?: number;
  /** GitHub's clock, as the runs listing reports it. */
  listDate?: string;
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
              { status: options.loginStatus ?? 200 },
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
          const headers = options.listDate !== undefined
            ? { date: options.listDate }
            : undefined;
          return Promise.resolve(
            new Response(JSON.stringify({ workflow_runs: runs }), {
              status: options.runsStatus ?? 200,
              ...(headers !== undefined ? { headers } : {}),
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

    it("prints instructions when the token cannot name its owner", async () => {
      await storeIdentity();
      withStub({ loginStatus: 403 });

      await requestCommand(deps);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
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

    it("reports a profile that points somewhere else", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        'export CF_TEST_RECORDS_KEY_FILE="/somewhere/else.json"\n',
      );

      expect(await collectCommand(deps)).toBe(0);

      // The profile is a person's file: the line that disagrees stays.
      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(
        'export CF_TEST_RECORDS_KEY_FILE="/somewhere/else.json"\n',
      );
    });

    it("leaves a profile that already exports the key file alone", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      const line = `export CF_TEST_RECORDS_KEY_FILE="$HOME/common-fabric/` +
        `test-records-key.json"\n`;
      await Deno.writeTextFile(join(home, ".zshrc"), line);

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(line);
    });

    it("throws with nowhere to keep the identity", async () => {
      withStub({});
      deps.env = () => undefined;

      await expect(collectCommand(deps)).rejects.toThrow(
        "Neither XDG_CONFIG_HOME nor HOME is set.",
      );
    });

    it("throws when the token cannot read the collector's login", async () => {
      await storeIdentity();
      withStub({ loginStatus: 403 });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Cannot read your GitHub login",
      );
    });

    it("names the status when the run listing fails", async () => {
      await storeIdentity();
      withStub({ runsStatus: 500 });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Listing minting runs failed: HTTP 500",
      );
    });

    it("names the endpoint it could not reach", async () => {
      await storeIdentity();
      withFetch(
        (() =>
          Promise.reject(new TypeError("connection refused"))) as typeof fetch,
      );

      await expect(collectCommand(deps)).rejects.toThrow(
        "Cannot reach https://api.github.com: connection refused",
      );
    });

    it("refuses a delivery sealed to another identity", async () => {
      const identity = await storeIdentity();
      const stranger = await generateIdentity();
      const fingerprint = await recipientFingerprint(identity.recipient);
      const sealed = await seal(
        stranger.recipient,
        new TextEncoder().encode(KEY_TEXT),
      );
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: [{ id: 7, name: `test-records-key-${fingerprint}` }],
        zip: storedZip(
          `${fingerprint}.sealed`,
          new TextEncoder().encode(JSON.stringify(sealed)),
        ),
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "does not open with the identity",
      );
    });

    it("refuses a delivery that is not a key file", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity, JSON.stringify({ hi: 1 }));
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      await expect(collectCommand(deps)).rejects.toThrow(
        "not a personal test-records key file",
      );
    });

    it("passes over an unnamed run of its own that delivered nothing", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[
          mintRun(identity.recipient, { id: 9, named: false }),
          mintRun(identity.recipient, { id: 3 }),
        ]],
        ...published,
      });

      // The newest run is this person's, but it published nothing for
      // this recipient, so the delivery of the older named run is the
      // one collected.
      let artifactsFor: string | undefined;
      const inner = deps.fetchImpl;
      deps.fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/runs/9/artifacts")) {
          artifactsFor = url;
          return Promise.resolve(
            new Response(JSON.stringify({ artifacts: [] }), { status: 200 }),
          );
        }
        return inner(input, init);
      }) as typeof fetch;

      expect(await collectCommand(deps)).toBe(0);
      expect(artifactsFor).toBeDefined();
      expect(urls.some((line) => line.includes("/runs/3/artifacts"))).toBe(
        true,
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

    it("throws when the token cannot name its owner", async () => {
      withStub({ loginStatus: 403 });

      await expect(setupCommand(deps)).rejects.toThrow(
        "Cannot read your GitHub login",
      );
    });

    it("says so when the run it watched delivered nothing", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: [],
      });

      await expect(setupCommand(deps)).rejects.toThrow(
        "published no delivery",
      );
    });

    it("mints again when the installed key file is not one", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        "not a key file",
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("says it is waiting once, however long it waits", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[], [], [mintRun(identity.recipient)]],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.filter((line) => line.includes("/runs?")).length).toBe(3);
    });

    it("stops examining runs from before the watch began", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const stale = mintRun(identity.recipient, {
        id: 1,
        named: false,
        created_at: "2026-08-21T02:00:00Z",
      });
      withStub({
        dispatchStatus: 403,
        listDate: "Fri, 21 Aug 2026 03:00:00 GMT",
        runPages: [
          [stale],
          [
            mintRun(identity.recipient, {
              id: 2,
              created_at: "2026-08-21T03:00:01Z",
            }),
            stale,
          ],
        ],
        artifacts: [],
        zip: published.zip,
      });
      const inner = deps.fetchImpl;
      deps.fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/runs/2/artifacts")) {
          return Promise.resolve(
            new Response(JSON.stringify({ artifacts: published.artifacts }), {
              status: 200,
            }),
          );
        }
        return inner(input, init);
      }) as typeof fetch;

      expect(await setupCommand(deps)).toBe(0);
      // The stale run is examined on the first round, which is what
      // fixes the clock, and left alone on every round after it.
      expect(
        urls.filter((line) => line.includes("/runs/1/artifacts")).length,
      ).toBe(1);
    });
  });

  describe("defaultGithubToken()", () => {
    const noCommand = () => {
      throw new Error("no command expected");
    };

    it("returns the token the environment carries", async () => {
      expect(
        await defaultGithubToken(
          (name) => name === "GH_TOKEN" ? "from-gh-token" : undefined,
          noCommand,
        ),
      ).toBe("from-gh-token");
      expect(
        await defaultGithubToken(
          (name) => name === "GITHUB_TOKEN" ? "from-github-token" : undefined,
          noCommand,
        ),
      ).toBe("from-github-token");
    });

    it("returns what the signed-in command line holds", async () => {
      expect(
        await defaultGithubToken(
          () => undefined,
          (command, args) => {
            expect(command).toBe("gh");
            expect(args).toEqual(["auth", "token"]);
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode("from-gh\n"),
            });
          },
        ),
      ).toBe("from-gh");
    });

    it("returns undefined when no source holds one", async () => {
      const empty = () => undefined;
      expect(
        await defaultGithubToken(
          empty,
          () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
        ),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(
          empty,
          () =>
            Promise.resolve({ code: 0, stdout: new TextEncoder().encode(" ") }),
        ),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(empty, () => Promise.reject(new Error("no"))),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(
          (name) => name === "GH_TOKEN" ? "" : undefined,
          () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
        ),
      ).toBeUndefined();
    });
  });

  describe("defaultDeps()", () => {
    it("returns the wiring the command line runs against", () => {
      const wiring = defaultDeps();
      expect(wiring.env).toBe(Deno.env.get);
      expect(wiring.fetchImpl).toBe(fetch);
      expect(typeof wiring.githubToken).toBe("function");
      expect(typeof wiring.pause).toBe("function");
    });
  });

  describe("INTERRUPT_NOTICE", () => {
    it("says how to pick the key up again", () => {
      expect(INTERRUPT_NOTICE).toContain("deno task test-records-key setup");
    });
  });

  describe("runCli()", () => {
    it("returns 2 and prints usage for a command it does not have", async () => {
      withStub({});
      expect(await runCli(["wat"], deps)).toBe(2);
      expect(await runCli([], deps)).toBe(2);
    });

    it("returns 2 for an argument the command does not take", async () => {
      withStub({});
      expect(await runCli(["setup", "--wat"], deps)).toBe(2);
      expect(await runCli(["request", "--wat"], deps)).toBe(2);
      expect(await runCli(["collect", "--wat"], deps)).toBe(2);
    });

    it("returns 1 and reports a failure a person can hit", async () => {
      withStub({});
      expect(await runCli(["collect"], deps)).toBe(1);
    });

    it("returns what the command it ran returned", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await runCli(["setup"], deps)).toBe(0);
      expect(await runCli(["request"], deps)).toBe(0);
    });

    it("lets a fault in the tool keep its stack", async () => {
      await storeIdentity();
      withStub({});
      deps.githubToken = () => Promise.reject(new RangeError("bug"));

      await expect(runCli(["collect"], deps)).rejects.toThrow(RangeError);
    });
  });
});
