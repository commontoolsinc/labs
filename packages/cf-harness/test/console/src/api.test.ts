import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cancelTurn } from "../../../console/src/api.ts";

const realFetch = globalThis.fetch;

/** Answers every request with one response, and remembers what was asked. */
const answerWith = (response: Response): { calls: number } => {
  const record = { calls: 0 };
  globalThis.fetch = () => {
    record.calls += 1;
    return Promise.resolve(response);
  };
  return record;
};

describe("console/src/api", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("cancelTurn", () => {
    it("resolves when the server takes the cancel", async () => {
      const asked = answerWith(Response.json({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked.calls).toBe(1);
    });

    it("rejects with the reason a refused cancel reported", async () => {
      answerWith(
        Response.json({ error: "no turn is running", code: "turn_not_found" }, {
          status: 404,
        }),
      );

      await expect(cancelTurn("session-a", "turn-a")).rejects.toThrow(
        "no turn is running",
      );
    });

    it("rejects with the status a refusal carrying no body reported", async () => {
      answerWith(new Response("", { status: 403, statusText: "Forbidden" }));

      await expect(cancelTurn("session-a")).rejects.toThrow("Forbidden");
    });
  });
});
