import { assertEquals, assertStrictEquals } from "@std/assert";
import { HttpProgramResolver } from "./program.ts";

Deno.test("HttpProgramResolver uses its injected fetch transport", async () => {
  const calls: string[] = [];
  const resolver = new HttpProgramResolver(
    "https://program.example/main.ts",
    (input) => {
      const url = input.toString();
      calls.push(url);
      return Promise.resolve(new Response(`source:${new URL(url).pathname}`));
    },
  );

  assertEquals(await resolver.main(), {
    name: "/main.ts",
    contents: "source:/main.ts",
  });
  assertEquals(await resolver.resolveSource("/dep.ts"), {
    name: "/dep.ts",
    contents: "source:/dep.ts",
  });
  assertEquals(calls, [
    "https://program.example/main.ts",
    "https://program.example/dep.ts",
  ]);
});

Deno.test("HttpProgramResolver calls the default fetch with the global receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: unknown, input): Promise<Response> {
    assertStrictEquals(this, globalThis);
    return Promise.resolve(
      new Response(`source:${new URL(input.toString()).pathname}`),
    );
  } as typeof globalThis.fetch;
  try {
    const resolver = new HttpProgramResolver(
      "https://program.example/main.ts",
    );
    assertEquals((await resolver.main()).contents, "source:/main.ts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
