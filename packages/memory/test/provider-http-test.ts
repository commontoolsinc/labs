import { assertEquals } from "@std/assert";
import { jsonErrorBody, jsonResponseSpecFor } from "../provider.ts";

Deno.test("memory provider http helpers shape success responses", () => {
  const response = jsonResponseSpecFor(
    { ok: { seq: 3 } },
    {
      okStatus: 200,
      okBody: (ok) => ({ ok }),
      errorBody: (error) => ({ error }),
      errorStatus: () => 503,
    },
  );

  assertEquals(response, {
    body: {
      ok: { seq: 3 },
    },
    status: 200,
  });
});

Deno.test("memory provider http helpers shape error responses", () => {
  const response = jsonResponseSpecFor(
    { error: { name: "AuthorizationError", message: "denied" } },
    {
      okStatus: 200,
      okBody: (ok) => ({ ok }),
      errorBody: (error) => ({ error }),
      errorStatus: (error) => error.name === "AuthorizationError" ? 401 : 503,
    },
  );

  assertEquals(response, {
    body: {
      error: {
        name: "AuthorizationError",
        message: "denied",
      },
    },
    status: 401,
  });
});

Deno.test("memory provider http helpers shape exception bodies", () => {
  const body = jsonErrorBody(new Error("boom"));

  assertEquals(body.error.name, "Error");
  assertEquals(body.error.message, "boom");
});

Deno.test("jsonErrorBody uses explicit fallback instead of default for non-Error causes", () => {
  // Without explicit fallback, null/undefined/non-Error causes would get
  // "Unable to parse request body" which is misleading in non-parsing contexts.
  const fromNull = jsonErrorBody(null, "Transaction failed");
  assertEquals(fromNull.error.message, "Transaction failed");

  const fromUndefined = jsonErrorBody(undefined, "Query failed");
  assertEquals(fromUndefined.error.message, "Query failed");

  const fromString = jsonErrorBody("some string");
  assertEquals(fromString.error.message, "Unable to parse request body");

  // An actual Error should still use its own message regardless of fallback.
  const fromError = jsonErrorBody(new Error("real message"), "fallback");
  assertEquals(fromError.error.message, "real message");
});
