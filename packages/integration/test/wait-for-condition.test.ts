import { assertEquals, assertRejects } from "@std/assert";
import { Browser } from "../browser.ts";
import { waitForCondition } from "../utils.ts";

Deno.test("waitForCondition transports only lossless JSON answers", async () => {
  const browser = await Browser.launch();
  const page = await browser.newPage();

  try {
    const answer = await waitForCondition(page, () => ({
      point: { x: 12.5, y: 24 },
      labels: ["ready", null, true],
    }));
    assertEquals(answer, {
      point: { x: 12.5, y: 24 },
      labels: ["ready", null, true],
    });

    const functionAnswer = () => () => "silently dropped by JSON.stringify";
    await assertRejects(
      () => {
        // @ts-expect-error Page-condition answers must be plain JSON values.
        return waitForCondition(page, functionAnswer);
      },
      Error,
      "function at $ is not JSON-safe",
    );
  } finally {
    await page.close().finally(() => browser.close());
  }
});
