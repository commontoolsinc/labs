import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "./types.ts";
import { discordOnline } from "./tiles/discord-online.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";

function ctx(env: Record<string, string>): Ctx {
  return { runs: () => Promise.resolve([]), env: (key) => env[key] };
}

Deno.test("discord online: error reason is truncated but not pre-escaped", async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  class ThrowingWebSocket extends EventTarget {
    constructor(_url: string | URL) {
      super();
      throw new Error("bad <token> & guild" + "x".repeat(200));
    }
    close(): void {}
    send(_data: string): void {}
  }
  globalThis.WebSocket = ThrowingWebSocket as typeof WebSocket;
  try {
    const view = await discordOnline.collect(ctx({ DISCORD_BOT_TOKEN: "t", DISCORD_GUILD_ID: "g" }));
    assertStringIncludes(view.sub ?? "", "bad <token> & guild");
    assertEquals((view.sub ?? "").includes("&lt;"), false);
    assertEquals((view.sub ?? "").length, 80);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

Deno.test("prod-errors: SigNoz timestamp/value pairs use the metric string", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ data: { result: [{ series: [{ values: [[1_700_000_000, "2.5"]] }] }] } })));
  try {
    const view = await prodErrors.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" }));
    assertEquals(view.status, "warn");
    assertEquals(view.value, "2.50%");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("prod-errors: unreachable SigNoz source is unknown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  try {
    const view = await prodErrors.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" }));
    assertEquals(view.status, "unknown");
    assertEquals(view.sub, "SigNoz unreachable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("gcp-spend: BigQuery fetch failures use friendlyError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("error sending request for url"));
  try {
    const view = await gcpSpend.collect(ctx({ GCP_BILLING_TABLE: "project.dataset.table" }));
    assertEquals(view.status, "unknown");
    assertEquals(view.sub, "source unreachable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
