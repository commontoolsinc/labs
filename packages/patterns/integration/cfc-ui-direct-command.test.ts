import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { PieceController, PiecesController } from "@commontools/piece/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import {
  type Runtime,
  type RuntimeProgram,
} from "@commontools/runner";
import type { Module } from "@commontools/runner";
import type { CfcTrustContext } from "@commontools/runner/shared";
import {
  deriveImplementationIdentity,
  implementationIdentityIntegrityAtom,
} from "../../runner/src/cfc/implementation-identity.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const INITIAL_DRAFT = "Summarize the latest inbox triage notes.";
const TRUSTED_DIRECT_COMMAND_UI_CONCEPT =
  "https://commonfabric.org/cfc/concepts/trusted-direct-command-ui";
type SubmittedAction = {
  command: string;
  submittedBy: string;
};
type CodeHashAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash";
  hash: string;
};

describe("CFC UI direct-command integration", () => {
  const shell = new ShellIntegration({ pipeConsole: false });
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let trustedPiece: PieceController;
  let trustedNegativePiece: PieceController;
  let untrustedPiece: PieceController;
  let pieceSinkCancels: Array<() => void> = [];
  let currentTrustContext: CfcTrustContext | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
      cfcTrustContext: () => currentTrustContext,
    });

    const trustedSourcePath = join(
      import.meta.dirname!,
      "..",
      "examples",
      "cfc-ui-direct-command.tsx",
    );
    const untrustedSourcePath = join(
      import.meta.dirname!,
      "..",
      "examples",
      "cfc-ui-direct-command-untrusted.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const trustedProgram = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(trustedSourcePath, rootPath),
    );
    const trustedCodeHash = await resolveTrustedSubmitHandlerCodeHash(
      cc.manager().runtime,
      trustedProgram,
    );
    currentTrustContext = createUiTrustContext(identity.did(), trustedCodeHash);

    trustedPiece = await cc.create(trustedProgram, { start: true });
    trustedNegativePiece = await cc.create(trustedProgram, { start: true });

    const untrustedProgram = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(untrustedSourcePath, rootPath),
    );
    untrustedPiece = await cc.create(untrustedProgram, { start: true });

    pieceSinkCancels = [
      cc.manager().getResult(trustedPiece.getCell()).sink(() => {}),
      cc.manager().getResult(trustedNegativePiece.getCell()).sink(() => {}),
      cc.manager().getResult(untrustedPiece.getCell()).sink(() => {}),
    ];
  });

  afterAll(async () => {
    for (const cancel of pieceSinkCancels) {
      cancel();
    }
    if (cc) await cc.dispose();
  });

  it("blocks untrusted UI, blocks unauthorized log writes, and allows only verifier-trusted direct-command submissions", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: trustedNegativePiece.id,
      },
      identity,
      cfcTrustContext: currentTrustContext,
    });

    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommand"]',
    );
    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommandUntrusted"]',
    );
    await waitForSelector(
      page,
      '[data-ui-action="AppendSyntheticAction"]',
    );
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 0",
    );

    await waitFor(async () => {
      return (
        (await getSubmittedActions(trustedNegativePiece)).length === 0 &&
        await trustedNegativePiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });

    shell.clearErrorLogs();

    await dispatchCtButtonHostClick(page, "AppendSyntheticAction");

    await waitFor(async () => {
      return (
        (await getSubmittedActions(trustedNegativePiece)).length === 0 &&
        await trustedNegativePiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });
    assertErrorLogIncludes(
      shell.errorLogs(),
      "CfcWriteAuthorizedByViolationError",
    );

    shell.clearErrorLogs();

    await dispatchCtButtonHostClick(page, "SubmitDirectCommandUntrusted");

    await waitFor(async () => {
      return (
        (await getSubmittedActions(trustedNegativePiece)).length === 0 &&
        await trustedNegativePiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });
    assertErrorLogIncludes(
      shell.errorLogs(),
      "CfcEventIntegrityViolationError",
    );
    assertErrorLogIncludes(shell.errorLogs(), "SubmitDirectCommandUntrusted");

    shell.clearErrorLogs();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: trustedPiece.id,
      },
      identity,
      cfcTrustContext: currentTrustContext,
    });

    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommand"]',
    );
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 0",
    );
    await waitFor(async () => {
      return (
        (await getSubmittedActions(trustedPiece)).length === 0 &&
        await trustedPiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });

    await dispatchCtButtonHostClick(page, "SubmitDirectCommand");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await waitFor(async () => {
      const submittedActions = await getSubmittedActions(trustedPiece);
      return (
        submittedActions.length === 1 &&
        submittedActions[0]?.command === INITIAL_DRAFT &&
        submittedActions[0]?.submittedBy === "trusted-direct-command-surface" &&
        await trustedPiece.result.get(["draft"]) === ""
      );
    });
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 1",
    );

    assertEquals((await getSubmittedActions(trustedPiece)).length, 1);
    assertEquals((await getSubmittedActions(trustedPiece))[0], {
      command: INITIAL_DRAFT,
      submittedBy: "trusted-direct-command-surface",
    });
    assertEquals(await trustedPiece.result.get(["draft"]), "");
    assertEquals(shell.errorLogs(), []);

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: untrustedPiece.id,
      },
      identity,
      cfcTrustContext: currentTrustContext,
    });

    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommand"]',
    );
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 0",
    );
    await waitFor(async () => {
      return (
        (await getSubmittedActions(untrustedPiece)).length === 0 &&
        await untrustedPiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });

    shell.clearErrorLogs();

    await dispatchCtButtonHostClick(page, "SubmitDirectCommand");

    await waitFor(async () => {
      return (
        (await getSubmittedActions(untrustedPiece)).length === 0 &&
        await untrustedPiece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });
    assertErrorLogIncludes(
      shell.errorLogs(),
      "CfcEventIntegrityViolationError",
    );
    assertErrorLogIncludes(shell.errorLogs(), "SubmitDirectCommand");
  });
});

async function getSubmittedActions(
  piece: PieceController,
): Promise<SubmittedAction[]> {
  const actions = await piece.result.get(["submittedActions"]);
  return Array.isArray(actions) ? actions as SubmittedAction[] : [];
}

function createUiTrustContext(
  delegator: string,
  codeHashAtom: CodeHashAtom,
) {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:direct-command-ui-verifier",
      scope: {
        concepts: [TRUSTED_DIRECT_COMMAND_UI_CONCEPT],
      },
    }],
    statements: [{
      verifier: "did:key:direct-command-ui-verifier",
      concrete: codeHashAtom,
      concept: TRUSTED_DIRECT_COMMAND_UI_CONCEPT,
    }],
  } as const;
}

async function resolveTrustedSubmitHandlerCodeHash(
  runtime: Runtime,
  program: RuntimeProgram,
): Promise<CodeHashAtom> {
  const { id, jsScript } = await runtime.harness.compile(program);
  const evaluated = await runtime.harness.evaluate(id, jsScript, program.files);
  const pattern = evaluated.main?.default as
    | {
      nodes?: Array<{
        module: Module & {
          cfcRequiredEventIntegrity?: unknown;
          cfcRequiredEventIntegrityLabel?: unknown;
        };
      }>;
    }
    | undefined;
  const handlerNode = pattern?.nodes?.find((node) =>
    node.module.wrapper === "handler" &&
    Array.isArray(node.module.cfcRequiredEventIntegrity) &&
    node.module.cfcRequiredEventIntegrityLabel === "SubmitDirectCommand"
  );
  if (!handlerNode) {
    throw new Error("No trust-guarded handler found in direct-command pattern");
  }
  const atom = implementationIdentityIntegrityAtom(
    deriveImplementationIdentity(handlerNode.module),
  );
  if (
    !atom || typeof atom !== "object" || Array.isArray(atom) ||
    (atom as { type?: unknown }).type !==
      "https://commonfabric.org/cfc/atom/CodeHash" ||
    typeof (atom as { hash?: unknown }).hash !== "string"
  ) {
    throw new Error("No CodeHash atom derived for trust-guarded handler");
  }
  return atom as CodeHashAtom;
}

async function waitForSelector(page: Page, selector: string): Promise<void> {
  await waitFor(async () => {
    try {
      return !!(await page.waitForSelector(selector, { strategy: "pierce" }));
    } catch {
      return false;
    }
  });
}

async function dispatchCtButtonHostClick(
  page: Page,
  action: string,
): Promise<void> {
  const handle = await page.waitForSelector(
    `[data-ui-action="${action}"]`,
    { strategy: "pierce" },
  );
  await handle.click();
}

function assertErrorLogIncludes(
  errorLogs: readonly string[],
  needle: string,
): void {
  assert(
    errorLogs.some((line) => line.includes(needle)),
    `Expected browser error logs to include "${needle}", got:\n${
      errorLogs.join("\n")
    }`,
  );
}

async function waitForTextAtSelector(
  page: Page,
  selector: string,
  expectedText: string,
): Promise<void> {
  await waitFor(async () => {
    try {
      const element = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      const text = await element.innerText();
      return text?.trim() === expectedText;
    } catch {
      return false;
    }
  });
}
