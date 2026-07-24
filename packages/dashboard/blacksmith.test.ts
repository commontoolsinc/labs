import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BlacksmithClient, blacksmithRoutes } from "./blacksmith.ts";

function environment(values: Record<string, string>) {
  return (name: string): string | undefined => values[name];
}

Deno.test("Blacksmith client: an unset token leaves the source disabled", () => {
  assertEquals(BlacksmithClient.fromEnvironment(environment({})), null);
  assertEquals(
    BlacksmithClient.fromEnvironment(
      environment({ BLACKSMITH_API_TOKEN: "  " }),
    ),
    null,
  );
});

Deno.test("Blacksmith client: invalid backend URLs are rejected before a request", () => {
  for (
    const value of [
      "not-a-url",
      "http://backend.blacksmith.sh",
      "ftp://localhost",
      "ws://localhost",
    ]
  ) {
    try {
      BlacksmithClient.fromEnvironment(
        environment({
          BLACKSMITH_API_TOKEN: "blacksmith-token",
          BLACKSMITH_API_URL: value,
        }),
      );
      throw new Error("expected invalid API URL to be rejected");
    } catch (error) {
      assertStringIncludes((error as Error).message, "BLACKSMITH_API_URL");
    }
  }
});

Deno.test("Blacksmith client: authenticated reads use the CLI bearer token", async () => {
  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      Response.json({ ok: true }),
    );
  };
  try {
    const client = BlacksmithClient.fromEnvironment(
      environment({ BLACKSMITH_API_TOKEN: "  blacksmith-token  " }),
    );
    assertEquals(await client?.get("billing"), { ok: true });
    assertEquals(
      requests[0].url,
      "https://backend.blacksmith.sh/api/billing",
    );
    assertEquals(
      requests[0].headers.get("authorization"),
      "Bearer blacksmith-token",
    );
    assertEquals(requests[0].headers.has("cookie"), false);
    assertEquals(requests[0].headers.has("origin"), false);

    const local = BlacksmithClient.fromEnvironment(
      environment({
        BLACKSMITH_API_TOKEN: "local-token",
        BLACKSMITH_API_URL: "http://localhost:9000/root/",
      }),
    );
    assertEquals(await local?.get("invoice"), { ok: true });
    assertEquals(
      requests[1].url,
      "http://localhost:9000/root/api/invoice",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("Blacksmith client: rejected tokens and failed reads have bounded errors", async () => {
  const realFetch = globalThis.fetch;
  const client = BlacksmithClient.fromEnvironment(
    environment({ BLACKSMITH_API_TOKEN: "blacksmith-token" }),
  )!;
  try {
    for (const status of [401, 403]) {
      globalThis.fetch = () => Promise.resolve(new Response(null, { status }));
      await assertRejects(
        () => client.get("billing"),
        Error,
        "API token rejected",
      );
    }

    globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 503 }));
    await assertRejects(
      () => client.get("billing"),
      Error,
      "HTTP 503",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("Blacksmith routes encode the organization and UTC range", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const end = new Date("2026-01-31T23:59:59.999Z");
  const route = blacksmithRoutes.daily("acme/tools", start, end);
  assertStringIncludes(route, "user/github/orgs/acme%2Ftools/metrics/daily?");
  assertStringIncludes(route, "start_date=2026-01-01T00%3A00%3A00.000Z");
  assertStringIncludes(route, "end_date=2026-01-31T23%3A59%3A59.999Z");
  assertEquals(
    blacksmithRoutes.invoiceAmount("acme/tools"),
    "user/github/orgs/acme%2Ftools/metrics/invoice-amount",
  );
  assertEquals(
    blacksmithRoutes.spendingThreshold("acme/tools"),
    "user/github/orgs/acme%2Ftools/email-alert-threshold",
  );
});
