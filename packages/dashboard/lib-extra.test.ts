// Unit tests for the helpers lib.test.ts does not reach: the GitHub API wrapper
// and the memo cache. No real network — fetch is stubbed and restored.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { friendlyError, github, memo } from "./lib.ts";

// Run `fn` with fetch replaced by `stub`, handing `fn` the calls made so far.
async function withFetch(
  stub: (url: string) => Response,
  fn: (calls: { url: string; init: RequestInit }[]) => Promise<void>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(stub(url));
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// Run `fn` with the token vars set as given; a key left out is unset for the
// duration. Whatever the process had is put back.
async function withTokens(env: Record<string, string>, fn: () => Promise<void>) {
  const keys = ["GH_TOKEN", "GITHUB_TOKEN"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  const apply = (k: string, v: string | undefined) => v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    for (const k of keys) apply(k, env[k]);
    await fn();
  } finally {
    for (const [k, v] of saved) apply(k, v);
  }
}

const auth = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).authorization;

Deno.test("github: no token -> a 'set GH_TOKEN' error, and no request is attempted", async () => {
  await withTokens({}, async () => {
    await withFetch(() => Response.json({}), async (calls) => {
      const e = await assertRejects(() => github("repos/o/r"), Error);
      assertEquals(e.message, "GitHub API repos/o/r: set GH_TOKEN or GITHUB_TOKEN");
      assertEquals(calls.length, 0);
      // The message is one friendlyError recognizes, so a token-gated tile grays
      // out with "set GH_TOKEN" rather than "temporarily unavailable".
      assertEquals(friendlyError(e.message), "set GH_TOKEN");
    });
  });
});

Deno.test("github: non-OK -> throws with the status; the error body is not returned as data", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await withFetch(() => Response.json({ message: "Not Found" }, { status: 404 }), async () => {
      const e = await assertRejects(() => github("repos/o/missing"), Error);
      assertEquals(e.message, "GitHub API repos/o/missing failed: HTTP 404");
      assertEquals(friendlyError(e.message), "not found");
    });
    await withFetch(() => Response.json({}, { status: 429 }), async () => {
      const e = await assertRejects(() => github("rate/limited"), Error);
      assertEquals(e.message, "GitHub API rate/limited failed: HTTP 429");
      assertEquals(friendlyError(e.message), "rate-limited");
    });
    await withFetch(
      () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
      async () => {
        const e = await assertRejects(() => github("rate/limited"), Error);
        assertEquals(
          e.message,
          "GitHub API rate/limited failed: HTTP 403 (rate-limited)",
        );
        assertEquals(friendlyError(e.message), "rate-limited");
      },
    );
  });
});

Deno.test("github: parsed JSON from api.github.com, with the auth and version headers", async () => {
  await withTokens({ GH_TOKEN: "env-token" }, async () => {
    await withFetch(() => Response.json({ login: "octocat", id: 1 }), async (calls) => {
      const body = await github<{ login: string; id: number }>("/user");
      assertEquals(body, { login: "octocat", id: 1 });
      assertEquals(calls.length, 1);
      // A leading slash on the path does not double up against the base url.
      assertEquals(calls[0].url, "https://api.github.com/user");
      const h = calls[0].init.headers as Record<string, string>;
      assertEquals(h.authorization, "Bearer env-token");
      assertEquals(h.accept, "application/vnd.github+json");
      assertEquals(h["x-github-api-version"], "2022-11-28");
      assert(calls[0].init.signal, "the request is bounded by a timeout signal");
    });
  });
});

Deno.test("github: an explicit token wins over the env; GITHUB_TOKEN backs up GH_TOKEN", async () => {
  await withFetch(() => Response.json({}), async (calls) => {
    await withTokens({ GH_TOKEN: "gh", GITHUB_TOKEN: "github" }, async () => {
      await github("x", "explicit");
      await github("x");
    });
    await withTokens({ GITHUB_TOKEN: "github" }, async () => {
      await github("x");
    });
    assertEquals(calls.map(auth), ["Bearer explicit", "Bearer gh", "Bearer github"]);
  });
});

Deno.test("memo: a result is reused within the ttl, refetched past it", async () => {
  let n = 0;
  const get = memo(60_000, () => Promise.resolve(++n));
  assertEquals(await get(), 1);
  assertEquals(await get(), 1);
  assertEquals(n, 1);
  // A negative ttl has elapsed at any clock reading, so every call refetches.
  let m = 0;
  const fresh = memo(-1, () => Promise.resolve(++m));
  assertEquals(await fresh(), 1);
  assertEquals(await fresh(), 2);
});

Deno.test("memo: a rejection is not cached -> the next call retries", async () => {
  let n = 0;
  const get = memo(60_000, () => {
    n++;
    return n === 1 ? Promise.reject(new Error("error sending request")) : Promise.resolve("ok");
  });
  const e = await assertRejects(() => get(), Error);
  assertEquals(e.message, "error sending request");
  // Still inside the ttl: a failure must not be held onto, or one blip would
  // gray a tile out for the whole window.
  assertEquals(await get(), "ok");
  assertEquals(n, 2);
});

Deno.test("memo: concurrent callers share the one in-flight call", async () => {
  let n = 0;
  let release: (v: string) => void = () => {};
  const get = memo(60_000, () => {
    n++;
    return new Promise<string>((r) => release = r);
  });
  const a = get(), b = get();
  release("v");
  assertEquals(await a, "v");
  assertEquals(await b, "v");
  assertEquals(n, 1);
});
