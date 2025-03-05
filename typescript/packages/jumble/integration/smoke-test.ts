import { Browser, launch } from "@astral/astral";
import { assert } from "@std/assert";
import {
  addCharm,
  inspectCharm,
  login,
  sleep,
  waitForSelectorWithText,
} from "./utils.ts";

const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:5173/";

async function main(browser: Browser) {
  console.log(`TOOLSHED_API_URL=${TOOLSHED_API_URL}`);
  console.log(`FRONTEND_URL=${FRONTEND_URL}`);

  const { charmId, space } = await addCharm(TOOLSHED_API_URL);
  console.log(`Charm added`, { charmId, space });

  console.log(`Waiting to open website at ${FRONTEND_URL}`);
  const page = await browser.newPage(FRONTEND_URL);
  console.log(`Opened website at ${FRONTEND_URL}`);

  console.log("Logging in");
  await login(page);

  console.log("Checking if logged in");
  const anchor = await page.waitForSelector("nav a");
  assert(
    (await anchor.innerText()) === "common-knowledge",
    "Logged in and Common Knowledge title renders",
  );

  await page.goto(`${FRONTEND_URL}${space}/${charmId}`);
  console.log(`Waiting for charm to render`);

  await waitForSelectorWithText(
    page,
    "a[aria-current='charm-title']",
    "Simple Value: 1",
  );
  console.log("Charm rendered.");

  console.log("Clicking button");
  // Sometimes clicking this button throws:
  // https://jsr.io/@astral/astral/0.5.2/src/element_handle.ts#L192
  // As if the reference was invalidated by a spurious re-render between
  // getting an element handle, and clicking it.
  await sleep(1000);
  const button = await page.waitForSelector(
    "div[aria-label='charm-content'] button",
  );
  await button.click();

  console.log("Checking if title changed");
  await waitForSelectorWithText(
    page,
    "a[aria-current='charm-title']",
    "Simple Value: 2",
  );
  console.log("Title changed");

  console.log("Inspecting charm to verify updates propagated from browser.");
  const charm = await inspectCharm(TOOLSHED_API_URL, space, charmId);
  console.log("Charm:", charm);
  assert(charm.includes("Simple Value: 2"), "Charm updates propagated.");
}

let browser = null;
try {
  browser = await launch();
  await main(browser);
  await browser.close();
} catch (e) {
  if (browser) {
    await browser.close();
  }
  console.error(e);
  Deno.exit(1);
}
