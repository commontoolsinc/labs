import { PageErrorEvent } from "@astral/astral";
import {
  Browser,
  dismissDialogs,
  Page,
  pipeConsole,
} from "@commontools/integration";
import { login } from "@commontools/integration/jumble";
import { assert } from "@std/assert";
import * as path from "@std/path";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { sleep } from "@commontools/utils/sleep";
import { decode } from "@commontools/utils/encoding";

const TAKE_SNAPSHOTS = false;
const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:5173/";
const HEADLESS = true;
const ASTRAL_TIMEOUT = 60_000;
const RECIPE_PATH = "../../recipes/simpleValue.tsx";
const COMMON_CLI_PATH = path.join(import.meta.dirname!, "../../cli");
const SNAPSHOTS_DIR = join(Deno.cwd(), "test_snapshots");

console.log(`TOOLSHED_API_URL=${TOOLSHED_API_URL}`);
console.log(`FRONTEND_URL=${FRONTEND_URL}`);

let browser: Browser | void = undefined;
let testCharm: { charmId: string; name: string } | void = undefined;

Deno.test({
  name: "integration tests",
  fn: async (t) => {
    let page: Page | void = undefined;
    let failed = false;
    const exceptions: string[] = [];

    try {
      failed = !await t.step({
        name: "add charm via cli",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          testCharm = await addCharm(TOOLSHED_API_URL, RECIPE_PATH);
          console.log(`Charm added`, testCharm);
        },
      });

      failed = !await t.step({
        name: "renders homepage",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          browser = await Browser.launch({
            timeout: ASTRAL_TIMEOUT,
            headless: HEADLESS,
          });

          console.log(`Opening empty page...`);
          page = await browser!.newPage();
          console.log(`Waiting to open website at ${FRONTEND_URL}`);

          // Add console log listeners
          page.addEventListener("console", pipeConsole);
          // Add dialog listeners (for alerts, confirms, etc.)
          page.addEventListener("dialog", dismissDialogs);
          // Add error listeners
          page.addEventListener("pageerror", (e: PageErrorEvent) => {
            console.error("Browser Page Error:", e.detail.message);
            exceptions.push(e.detail.message);
          });

          await page.goto(FRONTEND_URL);
          await page.applyConsoleFormatter();

          console.log(`Opened website at ${FRONTEND_URL}`);
        },
      });

      failed = !await t.step({
        name: "able to login to the app",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");
          await login(page);
        },
      });

      failed = !await t.step({
        name: "renders charm and verifies initial state",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");
          assert(testCharm, "Test charm should be defined");

          if (TAKE_SNAPSHOTS) {
            await page.snapshot("Initial state", SNAPSHOTS_DIR);
          }

          const anchor = await page.waitForSelector("nav a");
          assert(
            (await anchor.innerText()) === "common-knowledge",
            "Logged in and Common Knowledge title renders",
          );

          console.log(
            "Navigating to charm detail page",
            `${FRONTEND_URL}${testCharm.name}/${testCharm.charmId}`,
          );
          await page.goto(
            `${FRONTEND_URL}${testCharm.name}/${testCharm.charmId}`,
          );
          await page.applyConsoleFormatter();
          if (TAKE_SNAPSHOTS) {
            await page.snapshot("Waiting for charm to render", SNAPSHOTS_DIR);
          }

          await page.waitForSelectorWithText(
            "a[aria-roledescription='charm-link']",
            "Simple Value: 1",
          );
          if (TAKE_SNAPSHOTS) {
            await page.snapshot("Charm rendered.", SNAPSHOTS_DIR);
          }
          assert(true, "Charm rendered successfully");
        },
      });

      failed = !await t.step({
        name: "updates charm value via button click",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");
          assert(testCharm, "Test charm should be defined");

          await page.goto(
            `${FRONTEND_URL}${testCharm.name}/${testCharm.charmId}`,
          );
          await page.applyConsoleFormatter();

          // Wait for initial render
          await page.waitForSelectorWithText(
            "a[aria-roledescription='charm-link']",
            "Simple Value: 1",
          );

          await sleep(1000);
          console.log("Clicking button");

          const el = await page.waitForSelector(
            "div[aria-label='charm-content'] button",
          );
          await el.click();
          if (TAKE_SNAPSHOTS) {
            await page.snapshot("Button clicked", SNAPSHOTS_DIR);
          }

          // Add more wait time after click
          await sleep(2000);

          console.log("Checking if title changed");
          await page.waitForSelectorWithText(
            "a[aria-roledescription='charm-link']",
            "Simple Value: 2",
          );

          if (TAKE_SNAPSHOTS) {
            await page.snapshot("Title changed", SNAPSHOTS_DIR);
          }

          // Add additional wait time for persistence
          await sleep(2000);
        },
      });

      failed = !await t.step({
        name: "verifies charm updates are persisted",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");
          assert(testCharm, "Test charm should be defined");

          // Add initial wait time before checking
          await sleep(1000);

          console.log(
            "Inspecting charm to verify updates propagated from browser.",
          );
          const charm = await inspectCharm(
            TOOLSHED_API_URL,
            testCharm.name,
            testCharm.charmId,
          );

          console.log("Charm:", charm);
          assert(
            charm.includes("Simple Value: 2"),
            "Charm updates propagated.",
          );
        },
      });

      failed = !await t.step({
        name: "extend charm using llm",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");

          copyLLMCache();

          await page.keyboard.down("ControlLeft");
          await page.keyboard.press("k");
          await page.keyboard.up("ControlLeft");
          await sleep(1000);

          await page.keyboard.type("new");
          await sleep(1000);
          await page.keyboard.press("Enter");

          await sleep(500);
          await page.keyboard.type("show the data from @v");
          await sleep(500);
          await page.keyboard.press("Tab");
          await sleep(500);
          await page.keyboard.press("Enter");
          await sleep(500);
        },
      });

      failed = !await t.step({
        name: "check that we see the new charm",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");

          // check that we see the new charm
          await page.waitForSelectorWithText(
            "a[aria-roledescription='charm-link']",
            "SimpleValue2 Viewer",
          );

          // FIXME(ja): how to look at the actual iframe content?
          // https://github.com/lino-levan/astral/issues/77
          // should see: "Total Values: 3"
          // <div class="flex justify-between items-center"><h2 class="text-lg font-semibold">Total Values</h2><span class="bg-blue-500 text-white px-3 py-1 rounded-full font-bold">3</span></div>
        },
      });

      failed = !await t.step({
        name: "no errors in the console",
        fn: async () => {
          assert(page, "Page should be defined");

          const html = await page.evaluate(() => {
            return document.body.innerHTML;
          });

          console.log(html);

          exceptions.forEach((exception) => {
            console.error("Failure due to browser error:", exception);
          });

          assert(exceptions.length === 0, "No errors in the console");
        },
      });
    } finally {
      await browser?.close();
    }
  },
});

function copyLLMCache() {
  const base = path.dirname(path.fromFileUrl(import.meta.url));
  const dest = join(base, "../../toolshed", "cache", "llm-api-cache");
  ensureDirSync(dest);
  console.log("Copying LLM cache to", dest);
  // list files in cache and copy each to dest
  const src = join(base, "cache", "llm-api-cache");
  for (const file of Deno.readDirSync(src)) {
    console.log("Copying", file.name);
    Deno.copyFileSync(join(src, file.name), join(dest, file.name));
  }
}

async function addCharm(toolshedUrl: string, recipePath: string) {
  const name = `ci-${Date.now()}-${
    Math.random().toString(36).substring(2, 15)
  }`;
  const { success, stdout, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--spaceName",
      name,
      "--recipeFile",
      recipePath,
      "--cause",
      "ci",
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
      "OPERATOR_PASS": "common user",
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    throw new Error(`Failed to add charm: ${decode(stderr)}`);
  }

  const output = decode(stdout);
  const charmId = output.split("created charm: ")[1].trim();

  return {
    charmId,
    name,
  };
}

async function inspectCharm(
  toolshedUrl: string,
  name: string,
  charmId: string,
) {
  const { success, stdout, stderr } = await (new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "start",
      "--spaceName",
      name,
      "--charmId",
      charmId,
      "--quit",
      "true",
    ],
    env: {
      "TOOLSHED_API_URL": toolshedUrl,
      "OPERATOR_PASS": "common user",
    },
    cwd: COMMON_CLI_PATH,
  })).output();

  if (!success) {
    console.log(decode(stdout));
    throw new Error(`Failed to inspect charm: ${decode(stderr)}`);
  }

  return decode(stdout);
}
