import { assertEquals } from "@std/assert";
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
