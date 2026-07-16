import { assertEquals } from "@std/assert";
import { cachedRoute, ganttCacheKey } from "./server.ts";

Deno.test("ci-gantt route cache: concurrent requests share one render and cache successes", async () => {
  let renders = 0;
  const render = async () => {
    renders++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(`png-${renders}`, { headers: { "content-type": "image/png" } });
  };
  const [first, second] = await Promise.all([
    cachedRoute("test-ci-gantt", render, () => 1, 1000),
    cachedRoute("test-ci-gantt", render, () => 1, 1000),
  ]);
  assertEquals(await first.text(), "png-1");
  assertEquals(await second.text(), "png-1");
  assertEquals(renders, 1);

  const cached = await cachedRoute("test-ci-gantt", render, () => 2, 1000);
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

Deno.test("ci-gantt route cache: TTL begins after a slow render completes", async () => {
  let now = 0;
  let renders = 0;
  const render = () => {
    renders++;
    now = 2000;
    return Promise.resolve(new Response("png"));
  };

  await cachedRoute("slow-ci-gantt", render, () => now, 1000);
  now = 2500;
  await cachedRoute("slow-ci-gantt", render, () => now, 1000);
  assertEquals(renders, 1);
});

Deno.test("ci-gantt route cache: ignores only the request cache-buster", () => {
  const first = ganttCacheKey(new URL("https://dashboard/ci-gantt.png?count=20&t=1&branch=main"));
  const second = ganttCacheKey(new URL("https://dashboard/ci-gantt.png?branch=main&t=2&count=20"));
  const changed = ganttCacheKey(new URL("https://dashboard/ci-gantt.png?count=40&t=3&branch=main"));

  assertEquals(first, second);
  assertEquals(first === changed, false);
  assertEquals(new URL(first, "https://dashboard").searchParams.has("t"), false);
});
