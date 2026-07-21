import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { HttpProgramResolver } from "../program.ts";

describe("HttpProgramResolver", () => {
  it("invokes the default fetch with the host global as receiver", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    try {
      const resolver = new HttpProgramResolver(
        "https://patterns.example/main.ts",
      );
      expect(await resolver.main()).toEqual({
        name: "/main.ts",
        contents: "export default 42",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("invokes an injected fetch with the host global as receiver", async () => {
    const fetchImpl = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    const resolver = new HttpProgramResolver(
      "https://patterns.example/main.ts",
      fetchImpl,
    );
    expect(await resolver.main()).toEqual({
      name: "/main.ts",
      contents: "export default 42",
    });
  });
});
