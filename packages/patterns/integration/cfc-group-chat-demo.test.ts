import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickTrustedAction,
  clickTrustedActionAndWaitForText,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc group chat demo integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-group-chat-demo",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("gates sends through the trusted surface and shows injected unsigned claims as invalid", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });

    const roomOneButton = await page.waitForSelector(
      "#open-room-participant-1",
      {
        strategy: "pierce",
      },
    );
    await roomOneButton.click();

    await waitForDisabled(page, "#trusted-send-button-participant-1", true);

    await fillCfInput(
      page,
      "#trusted-profile-name-participant-1",
      "Alice",
    );
    await clickTrustedActionAndWaitForText(
      page,
      TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
      "#trusted-participants-panel-participant-1",
      "Alice",
    );

    await scrollIntoView(page, "#host-message-draft-participant-1");
    await fillCfInput(
      page,
      "#host-message-draft-participant-1",
      "Hello from Alice",
    );

    const hostSendButton = await page.waitForSelector(
      "#host-send-button-participant-1",
      { strategy: "pierce" },
    );
    await hostSendButton.click();

    await waitForRuntimeIdle(page);
    await waitForTextAbsent(
      page,
      "#shared-transcript-participant-1",
      "Hello from Alice",
    );
    await waitForDisabled(page, "#trusted-send-button-participant-1", true);

    await fillCfInput(
      page,
      "#trusted-message-draft-participant-1",
      "Hello from Alice",
    );

    await clickTrustedAction(page, TRUSTED_GROUP_CHAT_SEND_ACTION);
    await waitForText(
      page,
      "#shared-transcript-participant-1",
      "1 message",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Alice",
      "#shared-transcript-participant-1",
    );

    const backButton = await page.waitForSelector(
      "#back-to-lobby-participant-1",
      {
        strategy: "pierce",
      },
    );
    await backButton.click();

    const roomTwoButton = await page.waitForSelector(
      "#open-room-participant-2",
      {
        strategy: "pierce",
      },
    );
    await roomTwoButton.click();

    await waitForText(
      page,
      "#trusted-conversation-preview-participant-2",
      "1 message",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Alice",
      "#trusted-conversation-preview-participant-2",
    );
    await waitForDeepText(
      page,
      "#trusted-participants-panel-participant-2",
      "Alice",
    );
    await waitForDisabled(page, "#trusted-send-button-participant-2", true);

    await fillCfInput(
      page,
      "#trusted-profile-name-participant-2",
      "Bob",
    );
    await clickTrustedActionAndWaitForText(
      page,
      TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
      "#trusted-participants-panel-participant-2",
      "Bob",
    );

    await scrollIntoView(page, "#trusted-message-draft-participant-2");
    await fillCfInput(
      page,
      "#trusted-message-draft-participant-2",
      "Hello from Bob",
    );
    await clickTrustedAction(page, TRUSTED_GROUP_CHAT_SEND_ACTION);
    await waitForText(
      page,
      "#shared-transcript-participant-2",
      "2 messages",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Bob",
      "#shared-transcript-participant-2",
    );

    const addRandomInvalidButton = await page.waitForSelector(
      "#add-random-invalid-participant-2",
      { strategy: "pierce" },
    );
    await addRandomInvalidButton.click();

    await waitForText(
      page,
      "#shared-transcript-participant-2",
      "4 messages",
    );
    await waitForText(
      page,
      "#shared-transcript-participant-2",
      "Invalid claim",
    );
    await waitForInvalidAuthorshipState(
      page,
      "#shared-transcript-participant-2",
    );
  });
});

async function waitForDisabled(
  page: Page,
  selector: string,
  disabled: boolean,
) {
  let probe: { disabled?: boolean; selector: string } | undefined;
  try {
    await waitFor(async () => {
      try {
        const node = await page.waitForSelector(selector, {
          strategy: "pierce",
          timeout: 1_000,
        });
        probe = await node.evaluate((element: Element) => {
          const button = element instanceof HTMLButtonElement
            ? element
            : element.shadowRoot?.querySelector("button");
          return {
            selector: element.tagName.toLowerCase(),
            disabled: button instanceof HTMLButtonElement
              ? button.disabled
              : undefined,
          };
        });
        return probe.disabled === disabled;
      } catch {
        return false;
      }
    }, { timeout: 15_000, delay: 250 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for ${selector} disabled=${disabled}. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

async function waitForDeepText(
  page: Page,
  selector: string,
  text: string,
) {
  try {
    await waitFor(
      async () =>
        await page.evaluate((targetSelector, targetText) => {
          function collect(
            root: Document | ShadowRoot,
            result: Element[],
          ): void {
            for (const element of root.querySelectorAll("*")) {
              try {
                if (element.matches(targetSelector)) {
                  result.push(element);
                }
              } catch {
                return;
              }
              if (element.shadowRoot) {
                collect(element.shadowRoot, result);
              }
            }
          }

          function deepText(root: ParentNode): string {
            let content = "";
            if (root instanceof HTMLElement) {
              content = root.innerText ?? root.textContent ?? "";
            } else if (root instanceof ShadowRoot) {
              content = root.textContent ?? "";
            }
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) {
                content += ` ${deepText(element.shadowRoot)}`;
              }
            }
            return content;
          }

          const matches: Element[] = [];
          collect(document, matches);
          return matches.some((element) =>
            deepText(element).includes(targetText)
          );
        }, { args: [selector, text] }),
      { timeout: 15_000, delay: 250 },
    );
  } catch (cause) {
    throw new Error(
      `Timed out waiting for deep text "${text}" in "${selector}"`,
      { cause },
    );
  }
}

async function scrollIntoView(page: Page, selector: string) {
  const node = await page.waitForSelector(selector, {
    strategy: "pierce",
    timeout: 15_000,
  });
  await node.evaluate(async (element: Element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  });
}

async function waitForAuthorshipState(
  page: Page,
  expectedText: string,
  containerSelector?: string,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitFor(async () => {
      probe = await readAuthorshipProbe(page, containerSelector);
      return probe.hosts.some((host) =>
        host.state === "verified" &&
        host.textIntegrityState === "ok" &&
        host.renderedText.includes(expectedText) &&
        host.hasTrustedAvatar
      );
    }, { timeout: 15_000, delay: 250 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for verified authorship row. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

async function waitForInvalidAuthorshipState(
  page: Page,
  containerSelector?: string,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitFor(async () => {
      probe = await readAuthorshipProbe(page, containerSelector);
      return probe.hosts.some((host) =>
        host.state === "unknown" &&
        host.textIntegrityState === "blocked" &&
        !host.hasTrustedAvatar &&
        host.renderedText.includes("Content hidden by integrity policy")
      );
    }, { timeout: 15_000, delay: 250 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for invalid authorship row. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

type AuthorshipProbe = {
  hosts: Array<{
    state: string | undefined;
    textIntegrityState: string | undefined;
    renderedText: string;
    hasTrustedAvatar: boolean;
    hasValue: boolean;
    valueType: string;
    hasValueGetCfcLabel: boolean;
    hasValueResolveAsCell: boolean;
    hasAuthor: boolean;
    authorType: string;
    authorClaim: unknown;
    valueRef: unknown;
    valueLabel: unknown;
    valueSourceRef: unknown;
    valueSourceLabel: unknown;
    resolvedValueRef: unknown;
    resolvedValueLabel: unknown;
    resolvedValueSourceRef: unknown;
    resolvedValueSourceLabel: unknown;
  }>;
};

async function readAuthorshipProbe(
  page: Page,
  containerSelector?: string,
): Promise<AuthorshipProbe> {
  return await page.evaluate((targetContainerSelector?: string) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function deepText(root: ParentNode): string {
      let text = root instanceof Element || root instanceof ShadowRoot
        ? root.textContent ?? ""
        : "";
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          text += ` ${deepText(element.shadowRoot)}`;
        }
      }
      return text;
    }

    function isWithinContainer(
      element: Element,
      selector: string | undefined,
    ): boolean {
      if (!selector) {
        return true;
      }

      let current: Node | null = element;
      while (current) {
        if (current instanceof Element) {
          try {
            if (current.matches(selector)) {
              return true;
            }
          } catch {
            return false;
          }
        }
        const root = current.getRootNode();
        current = current.parentNode ??
          (root instanceof ShadowRoot ? root.host : null);
      }
      return false;
    }

    const collected: Element[] = [];
    collect(document, collected);
    const elements = collected.filter((element) =>
      isWithinContainer(element, targetContainerSelector)
    );
    const hosts = elements.map(async (element) => {
      const typedElement = element as unknown as {
        authorshipState?: string;
        textIntegrityState?: string;
        value?: {
          getCfcLabel?: () => Promise<unknown>;
          ref?: () => unknown;
          getSourceCell?: () => {
            getCfcLabel?: () => Promise<unknown>;
            ref?: () => unknown;
          };
          resolveAsCell?: () => {
            getCfcLabel?: () => Promise<unknown>;
            ref?: () => unknown;
            getSourceCell?: () => {
              getCfcLabel?: () => Promise<unknown>;
              ref?: () => unknown;
            };
          };
        };
        author?: {
          get?: () => unknown;
          sync?: () => Promise<unknown>;
        };
      };
      const value = typedElement.value;
      const resolvedValue = typeof value?.resolveAsCell === "function"
        ? await value.resolveAsCell()
        : null;
      const valueSource = value?.getSourceCell?.() ?? null;
      const resolvedValueSource = resolvedValue?.getSourceCell?.() ?? null;
      const author = typedElement.author;
      return {
        state: typedElement.authorshipState,
        textIntegrityState: typedElement.textIntegrityState,
        renderedText: deepText(element),
        hasTrustedAvatar:
          element.shadowRoot?.querySelector("[data-cfc-authorship-avatar]") !==
            null,
        hasValue: value !== undefined,
        valueType: typeof value,
        hasValueGetCfcLabel: typeof value?.getCfcLabel === "function",
        hasValueResolveAsCell: typeof value?.resolveAsCell === "function",
        hasAuthor: author !== undefined,
        authorType: typeof author,
        authorClaim: typeof author?.sync === "function"
          ? await author.sync()
          : author?.get?.() ?? author ?? null,
        valueRef: value?.ref?.() ?? null,
        valueLabel: await value?.getCfcLabel?.() ?? null,
        valueSourceRef: valueSource?.ref?.() ?? null,
        valueSourceLabel: await valueSource?.getCfcLabel?.() ?? null,
        resolvedValueRef: resolvedValue?.ref?.() ?? null,
        resolvedValueLabel: await resolvedValue?.getCfcLabel?.() ?? null,
        resolvedValueSourceRef: resolvedValueSource?.ref?.() ?? null,
        resolvedValueSourceLabel: await resolvedValueSource?.getCfcLabel?.() ??
          null,
      };
    });

    return Promise.all(hosts).then((resolvedHosts) => ({
      hosts: resolvedHosts,
    }));
  }, { args: [containerSelector] });
}
