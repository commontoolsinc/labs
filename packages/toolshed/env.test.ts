import { assertEquals } from "@std/assert";
import { EnvSchema } from "@/env.ts";

// Regression guard for the z.coerce.boolean() footgun: Boolean("false") === true,
// which would silently enable telemetry (and, with the all-span exporter, ship
// every HTTP request span) when an operator set OTEL_ENABLED=false to disable it.
Deno.test("OTEL_ENABLED parses strictly: only 'true'/'1' enable telemetry", () => {
  const otel = (v: string | undefined) =>
    EnvSchema.parse(v === undefined ? {} : { OTEL_ENABLED: v }).OTEL_ENABLED;

  assertEquals(otel("true"), true);
  assertEquals(otel("1"), true);

  // The cases the old z.coerce.boolean() got wrong:
  assertEquals(otel("false"), false);
  assertEquals(otel("0"), false);
  assertEquals(otel("no"), false);

  // Unset must default to off.
  assertEquals(otel(undefined), false);
});
