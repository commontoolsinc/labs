import { launch } from "@astral/astral";
import { assert } from "@std/assert";
import { addCharm, login } from "./utils.ts";

const FRONTEND_URL = "http://localhost:5173/";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { charmId, space } = await addCharm();
  console.log(`Charm added`, { charmId, space });

  const browser = await launch();
  console.log(`Waiting to open website at ${FRONTEND_URL}`);
  const page = await browser.newPage(FRONTEND_URL);
  console.log(`Opened website at ${FRONTEND_URL}`);

  console.log("Logging in");
  await login(page);

  // await sleep(1000);

  console.log("Checking if logged in");
  const anchor = await page.waitForSelector("nav a");
  assert(
    (await anchor.innerText()) === "common-knowledge",
    "Logged in and Common Knowledge title renders",
  );

  await page.goto(`${FRONTEND_URL}${space}/${charmId}`);
  console.log(`Waiting for charm to render`);

  await page.waitForSelector("a[aria-current='charm-title']");
  const el = await page.$("a[aria-current='charm-title']");
  console.log(await el?.innerText());
  assert(
    (await el!.innerText()) === "Simple Value: 1",
    "Charm renders",
  );

  console.log("Clicking button");
  const button = await page.waitForSelector(
    "div[aria-label='charm-content'] button",
  );
  await button.click();

  // FIXME(ja): sleep to let changes propagate to remote storage
  await sleep(1000);

  console.log("Checking if title changed");
  const el2 = await page.$("a[aria-current='charm-title']");
  assert(
    (await el2!.innerText()) === "Simple Value: 2",
    "Title changed",
  );

  await browser.close();
}

try {
  await main();
} catch (e) {
  console.error(e);
  Deno.exit(1);
}
