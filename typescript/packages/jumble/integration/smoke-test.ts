import { launch } from "@astral/astral";
import { assert } from "@std/assert";
import { login } from "./utils.ts";

const FRONTEND_URL = "http://localhost:5173/";

async function main() {
  const browser = await launch();
  console.log(`Waiting to open website at ${FRONTEND_URL}`);
  const page = await browser.newPage(FRONTEND_URL);
  console.log(`Opened website at ${FRONTEND_URL}`);

  await login(page);

  const anchor = await page.waitForSelector("nav a");
  assert(
    (await anchor.innerText()) === "common-knowledge",
    "Logged in and Common Knowledge title renders",
  );
  await browser.close();
}

try {
  await main();
} catch (e) {
  console.error(e);
  Deno.exit(1);
}
