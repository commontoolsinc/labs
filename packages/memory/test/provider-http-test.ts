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
