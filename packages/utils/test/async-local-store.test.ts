import { assertEquals } from "@std/assert";
import { SynchronousContextStore } from "../src/async-local-store.ts";

Deno.test("synchronous context never leaks across overlapping async work", async () => {
  const store = new SynchronousContextStore<string>();
  const resumeFirst = Promise.withResolvers<void>();
  const resumeSecond = Promise.withResolvers<void>();

  const first = store.run("first", async () => {
    assertEquals(store.getStore(), "first");
    await resumeFirst.promise;
    return store.getStore();
  });
  const second = store.run("second", async () => {
    assertEquals(store.getStore(), "second");
    await resumeSecond.promise;
    return store.getStore();
  });

  resumeFirst.resolve();
  assertEquals(await first, undefined);
  resumeSecond.resolve();
  assertEquals(await second, undefined);
  assertEquals(store.getStore(), undefined);
});
