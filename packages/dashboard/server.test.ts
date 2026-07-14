import { assertEquals } from "@std/assert";
import { cachedRoute } from "./server.ts";

Deno.test("ci-gantt route cache: concurrent requests share one render and cache successes", async () => {
  let renders = 0;
  const render = async () => {
    renders++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(`png-${renders}`, { headers: { "content-type": "image/png" } });
  };
  const [first, second] = await Promise.all([
    cachedRoute("test-ci-gantt", render, 1, 1000),
    cachedRoute("test-ci-gantt", render, 1, 1000),
  ]);
  assertEquals(await first.text(), "png-1");
  assertEquals(await second.text(), "png-1");
  assertEquals(renders, 1);

  const cached = await cachedRoute("test-ci-gantt", render, 2, 1000);
  assertEquals(await cached.text(), "png-1");
  assertEquals(renders, 1);
});

Deno.test("ci-gantt route cache: different parameters cannot render concurrently", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  let renders = 0;
  const first = cachedRoute("busy-ci-gantt-a", async () => {
    renders++;
    await gate;
    return new Response("png");
  });

  const second = await cachedRoute("busy-ci-gantt-b", () => {
    renders++;
    return Promise.resolve(new Response("other"));
  });
  assertEquals(second.status, 429);
  assertEquals(second.headers.get("retry-after"), "5");
  assertEquals(renders, 1);

  release();
  assertEquals((await first).status, 200);
});
