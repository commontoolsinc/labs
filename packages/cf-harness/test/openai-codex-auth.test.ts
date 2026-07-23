import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  completeOpenAICodexDeviceAuthorization,
  createOpenAICodexBrowserAuthorization,
  exchangeOpenAICodexAuthorizationCode,
  extractOpenAICodexAccountId,
  loginOpenAICodexWithBrowser,
  OPENAI_CODEX_CLIENT_ID,
  OpenAICodexAuthError,
  OpenAICodexAuthService,
  OpenAICodexCredentialResolver,
  startOpenAICodexDeviceAuthorization,
} from "../src/auth/openai-codex.ts";
import {
  InMemoryHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";

const jwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

Deno.test("Codex browser authorization pins the OpenCode/pi PKCE contract", async () => {
  const flow = await createOpenAICodexBrowserAuthorization({
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  const url = new URL(flow.url);

  assertEquals(url.origin, "https://auth.openai.com");
  assertEquals(url.pathname, "/oauth/authorize");
  assertEquals(url.searchParams.get("client_id"), OPENAI_CODEX_CLIENT_ID);
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://localhost:1455/auth/callback",
  );
  assertEquals(
    url.searchParams.get("scope"),
    "openid profile email offline_access",
  );
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assertEquals(url.searchParams.get("originator"), "cf-harness");
  assertEquals(flow.state.length > 20, true);
  assertEquals(flow.verifier.length > 40, true);
});

Deno.test("Codex account identity requires the pinned nested claim", () => {
  assertThrows(
    () =>
      extractOpenAICodexAccountId(jwt({
        chatgpt_account_id: "top-level-must-not-be-trusted",
      })),
    Error,
    "did not include a ChatGPT account id",
  );
});

Deno.test("Codex credential refresh is serialized per owner and persists rotation", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const original: OpenAICodexOAuthCredential = {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    }),
    refreshToken: "refresh-old",
    expiresAt: 1,
    accountId: "acct-1",
  };
  await store.set("loom:user-1", "openai-codex", original);
  let refreshes = 0;
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "loom:user-1",
    now: () => 10_000,
    fetchFn: (_input, init) => {
      assertEquals(init?.redirect, "error");
      refreshes += 1;
      assertEquals(String(init?.body).includes("refresh-old"), true);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
            }),
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
  });

  const [left, right] = await Promise.all([
    resolver.resolve(),
    resolver.resolve(),
  ]);

  assertEquals(refreshes, 1);
  assertEquals(left.refreshToken, "refresh-new");
  assertEquals(right.refreshToken, "refresh-new");
  assertEquals(
    (await store.get("loom:user-1", "openai-codex"))?.refreshToken,
    "refresh-new",
  );
});

Deno.test("Codex credential resolution never falls back after revocation", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "secret-refresh-token",
    expiresAt: 1,
    accountId: "acct-1",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () => Promise.resolve(new Response("revoked", { status: 400 })),
  });

  const error = await assertRejects(() => resolver.resolve()) as Error;
  assertEquals(error.message.includes("secret-refresh-token"), false);
  assertEquals(error.message, "OpenAI Codex token refresh failed (400)");
});

Deno.test("Codex browser login validates state and persists only after exchange", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const auth = new OpenAICodexAuthService(store, "local");
  const result = await loginOpenAICodexWithBrowser({
    authService: auth,
    onAuthorizationUrl: async (authorizationUrl) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      const response = await fetch(
        `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
      );
      assertEquals(response.status, 200);
    },
    fetchFn: (_input, init) => {
      assertEquals(init?.redirect, "error");
      assertStringIncludes(String(init?.body), "code=browser-code");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-browser",
              },
            }),
            refresh_token: "refresh-browser",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
    now: () => 1_000,
  });

  assertEquals(result.accountId, "acct-browser");
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "refresh-browser",
  );
});

Deno.test("Codex credential refresh honors pre-abort and releases its owner lock on mid-refresh abort", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-secret",
    expiresAt: 0,
    accountId: "acct-1",
  });
  let fetches = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: (_input, init) => {
      fetches += 1;
      assertEquals(init?.redirect, "error");
      markStarted();
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const preAborted = new AbortController();
  preAborted.abort(new DOMException("pre-aborted refresh", "AbortError"));
  await assertRejects(
    () => resolver.resolve(preAborted.signal),
    DOMException,
    "pre-aborted refresh",
  );
  assertEquals(fetches, 0);

  const midRefresh = new AbortController();
  const resolving = resolver.resolve(midRefresh.signal);
  await started;
  midRefresh.abort(new DOMException("mid-refresh abort", "AbortError"));
  await assertRejects(
    () => resolving,
    DOMException,
    "mid-refresh abort",
  );
  assertEquals(fetches, 1);
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "other-access",
    refreshToken: "other-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "other-account",
  });
});

Deno.test("Codex browser login ignores wrong-state callbacks and accepts the valid callback", async () => {
  const store = new InMemoryHarnessCredentialStore();
  let exchanges = 0;
  const result = await loginOpenAICodexWithBrowser({
    authService: new OpenAICodexAuthService(store, "local"),
    onAuthorizationUrl: async (authorizationUrl) => {
      const wrong = await fetch(
        "http://localhost:1455/auth/callback?code=bad&state=wrong",
      );
      assertEquals(wrong.status, 400);
      const state = new URL(authorizationUrl).searchParams.get("state");
      const valid = await fetch(
        `http://localhost:1455/auth/callback?code=good&state=${state}`,
      );
      assertEquals(valid.status, 200);
    },
    fetchFn: (_input, init) => {
      exchanges += 1;
      assertStringIncludes(String(init?.body), "code=good");
      return Promise.resolve(
        new Response(JSON.stringify({
          access_token: jwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-after-wrong-state",
            },
          }),
          refresh_token: "refresh-after-wrong-state",
          expires_in: 3600,
        })),
      );
    },
  });
  assertEquals(exchanges, 1);
  assertEquals(result.accountId, "acct-after-wrong-state");
});

Deno.test("Codex browser login cancellation closes the callback listener", async () => {
  const controller = new AbortController();
  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        ),
        signal: controller.signal,
        onAuthorizationUrl: () => controller.abort(),
      }),
    DOMException,
  );
});

Deno.test("Codex browser login rejects a pre-aborted signal before opening the listener", async () => {
  const controller = new AbortController();
  const reason = new DOMException("already canceled", "AbortError");
  controller.abort(reason);
  let authorizationUrls = 0;

  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        ),
        signal: controller.signal,
        onAuthorizationUrl: () => {
          authorizationUrls += 1;
        },
      }),
    DOMException,
    "already canceled",
  );
  assertEquals(authorizationUrls, 0);
});

Deno.test("Codex browser login rejects concurrent transactions for one owner", async () => {
  const controller = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const authService = new OpenAICodexAuthService(
    new InMemoryHarnessCredentialStore(),
    "local",
  );
  const first = loginOpenAICodexWithBrowser({
    authService,
    signal: controller.signal,
    onAuthorizationUrl: () => markReady(),
  });
  await ready;

  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService,
        onAuthorizationUrl: () => {},
      }),
    Error,
    "already in progress",
  );
  controller.abort(new DOMException("cancel first", "AbortError"));
  await assertRejects(() => first, DOMException, "cancel first");
});

Deno.test("Codex device login honors pending and slow_down intervals", async () => {
  const device = await startOpenAICodexDeviceAuthorization({
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD-EFGH",
            interval: 1,
          }),
          { status: 200 },
        ),
      ),
  });
  let clock = 0;
  const waits: number[] = [];
  let polls = 0;
  const result = await completeOpenAICodexDeviceAuthorization({
    device,
    now: () => clock,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
    fetchFn: (_input, init) => {
      const body = String(init?.body);
      if (body.includes("device_auth_id")) {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "deviceauth_authorization_pending" },
              }),
              { status: 403 },
            ),
          );
        }
        if (polls === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "slow_down" },
              }),
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorization_code: "device-code",
              code_verifier: "device-verifier",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-device",
              },
            }),
            refresh_token: "refresh-device",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
  });

  assertEquals(waits, [1_000, 1_000, 6_000]);
  assertEquals(result.accountId, "acct-device");
});

Deno.test("Codex device login stops on a terminal provider denial", async () => {
  let waits = 0;
  await assertRejects(
    () =>
      completeOpenAICodexDeviceAuthorization({
        device: {
          deviceAuthId: "device-denied",
          userCode: "DENIED",
          intervalMs: 1_000,
          verificationUrl: "https://auth.openai.com/codex/device",
        },
        now: () => 0,
        wait: () => {
          waits += 1;
          return Promise.resolve();
        },
        fetchFn: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: "access_denied" } }),
              { status: 403 },
            ),
          ),
      }),
    Error,
    "device authorization failed (403)",
  );
  assertEquals(waits, 1);
});

Deno.test("Codex refresh classifies invalid grants without exposing tokens", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "do-not-print-refresh",
    expiresAt: 0,
    accountId: "acct",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "invalid_grant" },
          }),
          { status: 400 },
        ),
      ),
  });

  const error = await assertRejects(() => resolver.resolve());
  assertEquals(error instanceof OpenAICodexAuthError, true);
  assertEquals((error as OpenAICodexAuthError).kind, "invalid_grant");
  assertEquals(
    (error as Error).message.includes("do-not-print-refresh"),
    false,
  );
});

Deno.test("Codex token exchange rejects malformed token responses before persistence", async () => {
  const error = await assertRejects(() =>
    exchangeOpenAICodexAuthorizationCode({
      code: "code",
      verifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      fetchFn: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access-only",
            }),
            { status: 200 },
          ),
        ),
    })
  );
  assertEquals(error instanceof OpenAICodexAuthError, true);
  assertEquals((error as OpenAICodexAuthError).kind, "malformed_response");
});
