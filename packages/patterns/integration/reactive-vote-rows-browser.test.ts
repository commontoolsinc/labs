/** Verifies rendered nested filters and mapped rows after writes from another replica. */

import { Identity } from "@commonfabric/identity";
import { Browser, env } from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import type { Cell } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { initializePiecesController } from "./pieces-controller.ts";
import { settleView, waitForSettledText } from "./cfc-browser-helpers.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const root = join(import.meta.dirname!, "..");
const fixtureRoot = join(import.meta.dirname!, "fixtures/reactive-vote-rows");

interface FixtureOutput {
  cast: { key: string; optionId: string; color: string };
  rename: { key: string; name: string };
}

describe("rendered vote rows across replicas", () => {
  const cases = ["nested", "mapped"].flatMap((variant) =>
    [false, true].map((crossSpace) => ({ variant, crossSpace }))
  );
  for (const { variant, crossSpace } of cases) {
    const profileLocation = crossSpace ? "cross-space" : "same-space";
    it(`updates ${variant} rows with ${profileLocation} profiles after remote writes`, async () => {
      const identity = await Identity.fromPassphrase(
        `reactive rows ${variant}`,
        { implementation: "noble" },
      );
      const spaceName = `${env.SPACE_NAME}-${variant}-${profileLocation}`;
      const cc = await initializePiecesController({
        space: spaceName,
        apiUrl: new URL(env.API_URL),
        identity,
      });
      let browser: Awaited<ReturnType<typeof Browser.launch>> | undefined;
      try {
        browser = await Browser.launch({ headless: true });
        await cc.ensureDefaultPattern();
        let input: object | undefined;
        let externalProfiles: Cell<{ name: string }[]> | undefined;
        if (crossSpace) {
          const profileController = await initializePiecesController({
            space: `${spaceName}-profiles`,
            apiUrl: new URL(env.API_URL),
            identity,
          });
          try {
            const profiles = cc.runtime.getCell<{ name: string }[]>(
              profileController.getSpace(),
              "remote-voter-profiles",
            );
            const initialized = await cc.runtime.editWithRetry((tx) => {
              const writableProfiles = profiles.withTx(tx);
              writableProfiles.set([]);
              for (const key of ["alice", "bob", "carol"]) {
                const profile = writableProfiles.elementById(key);
                profile.set({ name: key });
                writableProfiles.addUnique(profile);
              }
            });
            if (initialized.error) throw new Error(initialized.error.message);
            await cc.synced();
            input = { profiles };
            externalProfiles = profiles;
          } finally {
            await profileController.dispose();
          }
        }
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          {
            main: join(fixtureRoot, `${variant}.tsx`),
            root,
            testPaths: [join(fixtureRoot, "main.test.tsx")],
          },
        );
        const piece = await cc.create<FixtureOutput>(program, {
          start: true,
          input,
        });
        const output = cc.getResult<FixtureOutput>(piece.getCell());
        const page = await browser.newPage();
        const errors: string[] = [];
        page.addEventListener("pageerror", (event) => {
          errors.push(event.detail.message);
        });
        await page.goto(`${env.FRONTEND_URL}${spaceName}/${piece.id}`);
        await waitForPieceView(page, spaceName, piece.id);
        await login(page, identity);
        await settleView(page);
        for (const color of ["green", "yellow"]) {
          const sent = await cc.runtime.editWithRetry((tx) =>
            output.key("cast").withTx(tx).send({
              key: "alice",
              optionId: "one",
              color,
            })
          );
          if (sent.error) throw new Error(sent.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
          await waitForSettledText(
            page,
            variant === "mapped"
              ? `[data-row="one"][title="alice"][data-tally-colors="${color}"]`
              : '[data-row="one"][title="alice"]',
            variant === "mapped" ? "one:" : `one: ${color}`,
          );
          if (variant === "mapped") {
            await settleView(page);
            const swatches = await page.evaluate(() => {
              function collect(root: Document | ShadowRoot): string[] {
                const values = [
                  ...root.querySelectorAll('[data-row="one"] [data-swatch]'),
                ]
                  .map((element) => element.textContent ?? "");
                for (const element of root.querySelectorAll("*")) {
                  if (element.shadowRoot) {
                    values.push(...collect(element.shadowRoot));
                  }
                }
                return values;
              }
              return collect(document);
            });
            expect(swatches).toEqual([color]);
          }
        }
        const renamed = await cc.runtime.editWithRetry((tx) => {
          if (externalProfiles) {
            externalProfiles.withTx(tx).elementById("alice").key("name")
              .set("Alice Updated");
          } else {
            output.key("rename").withTx(tx).send({
              key: "alice",
              name: "Alice Updated",
            });
          }
        });
        if (renamed.error) throw new Error(renamed.error.message);
        await cc.runtime.settled(Infinity);
        await cc.synced();
        await waitForSettledText(
          page,
          '[data-row="one"][title="Alice Updated"]',
          "one: yellow",
        );
        for (const key of ["bob", "carol"]) {
          const inserted = await cc.runtime.editWithRetry((tx) =>
            output.key("cast").withTx(tx).send({
              key,
              optionId: "two",
              color: "green",
            })
          );
          if (inserted.error) throw new Error(inserted.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
        }
        await waitForSettledText(
          page,
          '[data-row="two"][title="bob,carol"]',
          variant === "mapped" ? "two: greengreen" : "two: green,green",
        );
        if (variant === "mapped") {
          await waitForSettledText(
            page,
            '[data-row="two"] [data-swatch="carol"]',
            "green",
          );
          await waitForSettledText(
            page,
            '[data-row="one"] [data-swatch="Alice Updated"]',
            "yellow",
          );
          await settleView(page);
          const rowOrder = await page.evaluate(() => {
            function collect(root: Document | ShadowRoot): string[] {
              const rows = [...root.querySelectorAll("[data-row]")]
                .map((element) => element.getAttribute("data-row")!);
              for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot) {
                  rows.push(...collect(element.shadowRoot));
                }
              }
              return rows;
            }
            return collect(document);
          });
          expect(rowOrder).toEqual(["two", "one"]);
        }
        if (errors.length) throw new Error(errors.join("; "));
        const artifactDir = Deno.env.get("CF_ROW_REPRO_ARTIFACT_DIR");
        if (artifactDir) {
          const artifactName = crossSpace ? `${variant}-cross-space` : variant;
          await Deno.mkdir(artifactDir, { recursive: true });
          await page.screenshot(join(artifactDir, `${artifactName}.png`));
          await Deno.writeTextFile(
            join(artifactDir, `${artifactName}.json`),
            JSON.stringify(
              {
                variant,
                profileLocation,
                url: `${env.FRONTEND_URL}${spaceName}/${piece.id}`,
                assertions: [
                  "remote colors",
                  "profile-only edit",
                  "remote membership",
                ],
                rankedRows: variant === "mapped"
                  ? ["two", "one"]
                  : ["one", "two"],
              },
              null,
              2,
            ),
          );
        }
      } finally {
        try {
          await browser?.close();
        } finally {
          await cc.dispose();
        }
      }
    });
  }
});
