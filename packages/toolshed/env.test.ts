import { assertEquals } from "@std/assert";
import { EnvSchema, runtimeExperimentalOptions } from "@/env.ts";

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

// The sibling boolean flags shared the same z.coerce.boolean() trap and now use
// the strict boolFlag() parse. Guard them so they can't silently regress.
Deno.test("DISABLE_LOG_REQ_RES / PLAID_SYNC_ALL_TRANSACTIONS parse strictly", () => {
  const flag = (key: string, v: string | undefined) =>
    (EnvSchema.parse(v === undefined ? {} : { [key]: v }) as Record<
      string,
      unknown
    >)[key];

  for (const key of ["DISABLE_LOG_REQ_RES", "PLAID_SYNC_ALL_TRANSACTIONS"]) {
    assertEquals(flag(key, "true"), true);
    assertEquals(flag(key, "1"), true);
    assertEquals(flag(key, "false"), false); // previously coerced to true
    assertEquals(flag(key, "0"), false);
    assertEquals(flag(key, undefined), false);
  }
});

Deno.test("runtimeExperimentalOptions maps env flags with tri-state fidelity", () => {
  const base = EnvSchema.parse({});
  // Unset flags stay undefined — the runner distinguishes "unset" from an
  // explicit false (an unset eagerSourceAnnotation must not stomp the
  // runner's ambient default).
  assertEquals(runtimeExperimentalOptions(base), {
    modernCellRep: undefined,
    persistentSchedulerState: undefined,
    eagerSourceAnnotation: undefined,
  });

  const explicit = EnvSchema.parse({
    EXPERIMENTAL_MODERN_CELL_REP: "true",
    EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "false",
    EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: "true",
  });
  assertEquals(runtimeExperimentalOptions(explicit), {
    modernCellRep: true,
    persistentSchedulerState: false,
    eagerSourceAnnotation: true,
  });
});
