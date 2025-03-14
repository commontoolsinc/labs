import {
  Browser,
  ConsoleEvent,
  DialogEvent,
  launch,
  Page,
  PageErrorEvent,
} from "@astral/astral";
import { assert } from "@std/assert";
import {
  addCharm,
  copyLLMCache,
  inspectCharm,
  login,
  Mutable,
  sleep,
  snapshot,
  waitForSelectorClick,
  waitForSelectorWithText,
} from "./utils.ts";

const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:5173/";
const HEADLESS = true;

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
          testCharm = await addCharm(TOOLSHED_API_URL);
          console.log(`Charm added`, testCharm);
        },
      });

      failed = !await t.step({
        name: "renders homepage",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          browser = await launch({ headless: HEADLESS });

          console.log(`Opening empty page...`);
          page = await browser!.newPage();
          console.log(`Waiting to open website at ${FRONTEND_URL}`);
          {
            const mutPage: Mutable<Page> = page;
            // @ts-ignore We wrap Page in a Mutable
            // so we can override the readonly `timeout`
            // property. Type checker doesn't like this.
            mutPage.timeout = 60000;
          }
          await page.goto(FRONTEND_URL);

          // Add console log listeners
          page.addEventListener("console", (e: ConsoleEvent) => {
            console.log(`Browser Console [${e.detail.type}]: ${e.detail.text}`);
          });

          // Add error listeners
          page.addEventListener("pageerror", (e: PageErrorEvent) => {
            console.error("Browser Page Error:", e.detail.message);
            exceptions.push(e.detail.message);
          });

          // Add dialog listeners (for alerts, confirms, etc.)
          page.addEventListener("dialog", async (e: DialogEvent) => {
            const dialog = e.detail;
            console.log(`Browser Dialog: ${dialog.type} - ${dialog.message}`);
            await dialog.dismiss();
          });

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

          await snapshot(page, "Initial state");

          const anchor = await page.waitForSelector("nav a");
          assert(
            (await anchor.innerText()) === "common-knowledge",
            "Logged in and Common Knowledge title renders",
          );

          await page.goto(
            `${FRONTEND_URL}${testCharm.name}/${testCharm.charmId}`,
          );
          await snapshot(page, "Waiting for charm to render");

          await waitForSelectorWithText(
            page,
            "a[aria-roledescription='charm-link']",
            "Simple Value: 1",
          );
          await snapshot(page, "Charm rendered.");
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

          // Wait for initial render
          await waitForSelectorWithText(
            page,
            "a[aria-roledescription='charm-link']",
            "Simple Value: 1",
          );

          await sleep(1000);
          console.log("Clicking button");

          await waitForSelectorClick(
            page,
            "div[aria-label='charm-content'] button",
          );
          await snapshot(page, "Button clicked");

          // Add more wait time after click
          await sleep(2000);

          console.log("Checking if title changed");
          await waitForSelectorWithText(
            page,
            "a[aria-roledescription='charm-link']",
            "Simple Value: 2",
          );

          await snapshot(page, "Title changed");

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

          await page.keyboard.type("extend");
          await sleep(1000);
          await page.keyboard.press("Enter");

          await sleep(1000);
          await page.keyboard.type("count of values");
          await sleep(1000);
          await page.keyboard.press("Enter");
          await sleep(1000);
        },
      });

      failed = !await t.step({
        name: "check that we see the new charm",
        ignore: failed || exceptions.length > 0,
        fn: async () => {
          assert(page, "Page should be defined");

          // check that we see the new charm
          await waitForSelectorWithText(
            page,
            "a[aria-roledescription='charm-link']",
            "Value Counter",
          );

          // FIXME(ja): how to look at the actual iframe content?
          // https://github.com/lino-levan/astral/issues/77
          // should see: "Total Values: 3"
          // <div class="flex justify-between items-center"><h2 class="text-lg font-semibold">Total Values</h2><span class="bg-blue-500 text-white px-3 py-1 rounded-full font-bold">3</span></div>
        },
      });

      failed = !await t.step({
        name: "no errors in the console",
        fn: () => {
          assert(page, "Page should be defined");

          exceptions.forEach((exception) => {
            console.error("Failure due to browser error:", exception);
          });

          assert(exceptions.length === 0, "No errors in the console");
        },
      });
    } finally {
      await browser!.close();
    }
  },
});
