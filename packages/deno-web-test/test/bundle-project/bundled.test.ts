import { assertEquals } from "@std/assert";

Deno.test("a bundled module loads into a realm the page creates", async function () {
  const worker = new Worker("/worker.js", { type: "module" });
  try {
    const message = await new Promise<MessageEvent>((resolve, reject) => {
      worker.onmessage = resolve;
      worker.onerror = (event) => reject(new Error(String(event.message)));
    });
    assertEquals(message.data, 2);
  } finally {
    worker.terminate();
  }
});
