/** Verifies rendered nested filters and mapped rows after writes from another replica. */

import { Identity } from "@commonfabric/identity";
import { Browser, env } from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { initializePiecesController } from "./pieces-controller.ts";
import { settleView, waitForSettledText } from "./cfc-browser-helpers.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const root = join(import.meta.dirname!, "..");
const fixtureRoot = join(import.meta.dirname!, "fixtures/reactive-vote-rows");

describe("rendered vote rows across replicas", () => {
  for (const variant of ["nested", "mapped"]) {
    it(`updates ${variant} rows after a separate runtime edits a linked vote`, async () => {
      const identity = await Identity.fromPassphrase(
        `reactive rows ${variant}`,
        { implementation: "noble" },
      );
      const spaceName = `${env.SPACE_NAME}-${variant}`;
      const cc = await initializePiecesController({
        space: spaceName,
        apiUrl: new URL(env.API_URL),
        identity,
      });
      let browser: Awaited<ReturnType<typeof Browser.launch>> | undefined;
      try {
        browser = await Browser.launch({ headless: true });
        await cc.ensureDefaultPattern();
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          {
            main: join(fixtureRoot, `${variant}.tsx`),
            root,
            testPaths: [join(fixtureRoot, "main.test.tsx")],
          },
        );
        const piece = await cc.create<
          { cast: { key: string; optionId: string; color: string } }
        >(program, { start: true });
        const output = cc.getResult<
          { cast: { key: string; optionId: string; color: string } }
        >(piece.getCell());
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
            '[data-row="one"][title="alice"]',
            `one: ${color}`,
          );
        }
        if (errors.length) throw new Error(errors.join("; "));
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
