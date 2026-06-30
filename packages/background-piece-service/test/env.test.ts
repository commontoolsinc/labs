import { assertEquals } from "@std/assert";
import { loadEnv } from "../src/env.ts";

// Regression guard for the z.coerce.boolean() footgun: Boolean("false") === true
// would silently enable telemetry. loadEnv takes an injectable source so the
// OTEL_ENABLED transform can be tested without touching the real process env.
Deno.test("loadEnv: OTEL_ENABLED only enables on 'true'/'1'", () => {
  const otel = (v: string | undefined) =>
    loadEnv((key) => (key === "OTEL_ENABLED" ? v : undefined)).OTEL_ENABLED;

  assertEquals(otel("true"), true);
  assertEquals(otel("1"), true);

  // The cases the old z.coerce.boolean() got wrong:
  assertEquals(otel("false"), false);
  assertEquals(otel("0"), false);
  assertEquals(otel("no"), false);

  // Unset defaults to off.
  assertEquals(otel(undefined), false);
});
