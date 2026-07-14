import { assertEquals } from "@std/assert";
import { isMemoryWireAccountingEnabled } from "./memory-wire-accounting-policy.ts";

Deno.test("isMemoryWireAccountingEnabled: disabled without a non-empty token", () => {
  assertEquals(
    isMemoryWireAccountingEnabled({ token: "", env: "development" }),
    false,
  );
  assertEquals(
    isMemoryWireAccountingEnabled({ token: "   ", env: "test" }),
    false,
  );
});

Deno.test("isMemoryWireAccountingEnabled: enabled only in development and test", () => {
  assertEquals(
    isMemoryWireAccountingEnabled({ token: "secret", env: "development" }),
    true,
  );
  assertEquals(
    isMemoryWireAccountingEnabled({ token: "secret", env: "test" }),
    true,
  );
  assertEquals(
    isMemoryWireAccountingEnabled({ token: "secret", env: "Development" }),
    true,
  );
});

Deno.test("isMemoryWireAccountingEnabled: production, staging, aliases, and unknown envs fail closed", () => {
  for (
    const env of [
      "production",
      "Production",
      "prod",
      "staging",
      "rapids",
      "local",
      "",
    ]
  ) {
    assertEquals(
      isMemoryWireAccountingEnabled({ token: "secret", env }),
      false,
      env,
    );
  }
});
