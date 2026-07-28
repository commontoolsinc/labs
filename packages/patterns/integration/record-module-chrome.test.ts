/**
 * The chrome a Record draws around each module it holds: the header label and
 * the settings dialog.
 *
 * Both read fields off the module itself rather than off the Record's own list.
 * The header shows the module's instance label — the email module's "Personal"
 * or "Work" — falling back to the module type's generic name ("Email") when the
 * module has none, and the settings dialog shows the module's own `settingsUI`
 * under a title carrying that same instance label. Reading either means going
 * through `SubPieceEntry.piece`, which is typed `unknown`: that is the schema
 * the runner reads back as undefined instead of materializing the value, so
 * these reads saw nothing, the header fell back to the type name, and the
 * dialog opened with a body that was always null. record.tsx now takes them
 * through lifts whose operands name the fields being read.
 *
 * The shell is navigated once in the setup, and each case below drives the
 * page from there, so neither depends on the other having run.
 *
 * This is a browser test because the values it checks exist only in the
 * rendered UI. `record-module-fields.test.tsx` covers the same reads where a
 * headless pattern test can see them: the icon and the aliases in [NAME].
 *
 * The setup is also the only coverage of one thing the Record does not show:
 * writing the module list through the piece API. An entry that stores an
 * explicit undefined in its string-typed `label` makes that write fail, so the
 * `updateModule` send below is what catches a regression there.
 *
 * The assertions read the rendered text of the whole page, so each one names
 * text only the Record's own chrome produces. The type icon and the instance
 * label sit together in the header ("📧 Personal"), which no module body
 * renders: an email module shows its label only as the value of an input, and
 * the photo module shows its label only once a photo is uploaded.
 */
import {
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  fillCfInput,
  settleView,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;
const SPACE_NAME = "record-module-chrome-" + Date.now().toString(36);

const CLICK_TARGET_ATTR = "data-record-click-target";

/**
 * Tag the first rendered element matching `selector` so the test can click it.
 * Runs in the page, so it closes over nothing in this module. The Record's
 * module-header controls are plain buttons that carry their purpose in `title`,
 * which is what the selector addresses.
 */
const markClickTarget = (
  probe: ProbeApi,
  selector: string,
  token: string,
  attr: string,
): boolean => {
  for (const element of probe.collect(selector)) {
    if (!probe.isRendered(element)) continue;
    element.setAttribute(attr, token);
    return true;
  }
  return false;
};

/** Click the first rendered element matching `selector`. */
async function clickBySelector(page: Page, selector: string): Promise<void> {
  const token = `record-target-${crypto.randomUUID()}`;
  await waitForCondition(page, markClickTarget, {
    args: [selector, token, CLICK_TARGET_ATTR],
  });
  const target = await page.waitForSelector(
    `[${CLICK_TARGET_ATTR}="${token}"]`,
    { strategy: "pierce" },
  );
  await target.click();
}

describe("record module chrome integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let record: PieceController;
  let pieceId: string;
  const cancels: Array<() => void> = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(
        join(import.meta.dirname!, "..", "record.tsx"),
      ),
    );
    record = await cc.create(program, {
      input: { title: "Elizabeth Bennet", subPieces: [], trashedSubPieces: [] },
      start: true,
    });
    pieceId = record.id;
    // Keep the piece reactive (pull mode) so its handlers run on send.
    cancels.push(cc.manager().getResult(record.getCell()).sink(() => {}));

    // Two emails take the first two standard labels, "Personal" and "Work". The
    // photo module is the one that exports a settingsUI; its label is set
    // explicitly, so the dialog title has an instance label to show.
    for (const type of ["email", "email", "photo"]) {
      await record.result.set({ type }, ["addModule"]);
      await cc.manager().runtime.idle();
    }
    // The list also holds the modules the Record seeded itself with, so the
    // photo is addressed by its type rather than by the order it was added in.
    const entries = await record.result.get(["subPieces"]) as {
      type?: string;
    }[];
    const photoIndex = entries.findIndex((entry) => entry?.type === "photo");
    if (photoIndex < 0) throw new Error("the photo module was not added");
    await record.result.set(
      { index: photoIndex, field: "label", value: "Portrait" },
      ["updateModule"],
    );
    await cc.manager().runtime.idle();
    await cc.manager().synced();

    // Navigate once, here rather than in the first case, so each case below
    // starts from a shell showing the Record and none of them depends on an
    // earlier one having navigated.
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity,
    });
  });

  afterAll(async () => {
    for (const cancel of cancels) cancel();
    if (cc) await cc.dispose();
  });

  it("heads each module with that module's own label", async () => {
    const page = shell.page();
    await settleView(page);

    // The modules themselves render: an email module's own UI is on screen.
    await waitForText(page, "cf-field", "Email");

    // Each header names the module instance rather than its type.
    await waitForText(page, "body", "📧 Personal");
    await waitForText(page, "body", "📧 Work");
    await waitForText(page, "body", "📷 Portrait");
  });

  it("opens a module's own settings, bound to the module they came from", async () => {
    const page = shell.page();
    await settleView(page);

    // Nothing of the photo module's settings is on the page until the dialog
    // opens, so the text below is what the click produces.
    await waitForTextAbsent(page, "body", "Photo Label");

    // The gear appears only on a module that exports a settingsUI, so finding
    // one to click also pins that the photo module is offering one.
    await clickBySelector(page, 'button[title="Settings"]');
    await settleView(page);

    // The title carries the module's instance label, and the body is the photo
    // module's own settings control.
    await waitForText(page, "cf-modal[open]", "📷 Portrait Settings");
    await waitForText(page, "cf-modal[open]", "Photo Label");

    // That control is the module's own node rather than a copy of it: typing a
    // new label into it reaches the photo module, and the Record's header
    // follows the module's new label.
    await fillCfInput(page, "cf-modal[open] cf-input", "Headshot");
    await settleView(page);
    await waitForText(page, "body", "📷 Headshot");
  });
});
