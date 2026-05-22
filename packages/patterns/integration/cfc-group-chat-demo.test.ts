import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickCfButton,
  fillCfInput,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const CFC_GROUP_CHAT_TIMEOUT = 30_000;

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

  it("gates sends through the trusted surface and records imported claims", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });
    await waitForRuntimeIdle(page);
    await waitFor(async () => await setSchedulerPullMode(page, false));

    await waitForText(page, "#group-chat-manager-chip", "Manager off");
    await waitForDisabled(page, "#trusted-send-button", true);

    await scrollIntoView(page, "#trusted-profile-name");
    await fillCfInput(
      page,
      "#trusted-profile-name",
      "Alice",
    );
    await waitForDisabled(page, "#trusted-profile-save", false);
    await clickCfButton(page, "#trusted-profile-save");
    await waitForText(page, "#trusted-profile-status", "Alice");
    await waitForText(
      page,
      "#trusted-admin-manager-status",
      "Can manage admins",
    );
    await waitForText(
      page,
      "#group-chat-manager-chip",
      "Can manage admins",
    );
    await waitForText(
      page,
      "#trusted-admin-manager-panel-status",
      "Admin registry editing enabled",
    );
    await waitForRuntimeIdle(page);

    await scrollIntoView(page, "#trusted-room-name");
    await fillCfInput(
      page,
      "#trusted-room-name",
      "Ops",
    );
    await waitForDisabled(page, "#trusted-room-add-button", true);
    await scrollIntoView(page, "#trusted-admin-panel");
    await waitForText(
      page,
      '[data-ui-action="TrustedGroupChatSetAdmin"]',
      "Make admin",
    );
    await waitForDisabled(
      page,
      '[data-ui-action="TrustedGroupChatSetAdmin"]',
      false,
    );
    await clickCfButton(
      page,
      '[data-ui-action="TrustedGroupChatSetAdmin"]',
    );
    await waitForText(page, "#trusted-admin-user-list", "Admin");
    await waitForText(
      page,
      '[data-ui-action="TrustedGroupChatSetAdmin"]',
      "Remove admin",
    );
    await waitForRuntimeIdle(page);
    await fillCfInput(
      page,
      "#trusted-room-name",
      "Ops",
    );
    await waitForDisabled(page, "#trusted-room-add-button", false);
    await waitForRuntimeIdle(page);
    await clickCfButton(page, "#trusted-room-add-button");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#rooms-panel", "1 room");
    await waitForText(page, "#rooms-panel", "Ops");

    await scrollIntoView(page, "#host-message-draft");
    await fillCfInput(
      page,
      "#host-message-draft",
      "Fake hello from Alice",
    );
    await clickCfButton(page, "#host-send-button");
    await waitForRuntimeIdle(page);
    await waitForTextAbsent(
      page,
      "#trusted-conversation-preview",
      "Fake hello from Alice",
    );

    await scrollIntoView(page, "#trusted-message-draft");
    await fillCfInput(
      page,
      "#trusted-message-draft",
      "Hello from Alice",
    );
    await waitForRuntimeIdle(page);
    await waitForDisabled(page, "#trusted-send-button", false);
    await clickCfButton(page, "#trusted-send-button");
    await waitForText(
      page,
      "#trusted-conversation-preview",
      "1 message",
    );
    await readPieceResult(page, pieceId);
    await waitForRuntimeIdle(page);
    await waitForAuthorshipState(
      page,
      "Hello from Alice",
      "#trusted-conversation-preview",
    );

    await clickCfButton(page, "#add-random-messages");

    await waitForText(
      page,
      "#trusted-conversation-preview",
      "2 messages",
    );
  });
});

async function readPieceResult(page: Page, pieceId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const commonfabric = globalThis.commonfabric as
      | { readCell?: (options: { id: string }) => Promise<unknown> }
      | undefined;
    await commonfabric?.readCell?.({ id });
  }, { args: [pieceId] });
}

async function setSchedulerPullMode(
  page: Page,
  pullMode: boolean,
): Promise<boolean> {
  return await page.evaluate<Promise<boolean>, [boolean]>(
    async (pullMode) => {
      const rt = globalThis.commonfabric?.rt;
      if (!rt?.setPullMode || !rt?.idle) return false;
      await rt.setPullMode(pullMode);
      await rt.idle();
      return true;
    },
    { args: [pullMode] },
  );
}
async function scrollIntoView(page: Page, selector: string) {
  const node = await page.waitForSelector(selector, {
    strategy: "pierce",
    timeout: CFC_GROUP_CHAT_TIMEOUT,
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
    }, { timeout: CFC_GROUP_CHAT_TIMEOUT, delay: 250 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for verified authorship row. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

type AuthorshipProbe = {
  totalHosts: number;
  containerText: string;
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
    const matchingContainers: Element[] = [];
    if (targetContainerSelector) {
      const selector = targetContainerSelector;
      function collectMatchingContainers(root: Document | ShadowRoot): void {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(selector)) {
              matchingContainers.push(element);
            }
          } catch {
            // Invalid selectors are reported by returning an empty text probe.
          }
          if (element.shadowRoot) {
            collectMatchingContainers(element.shadowRoot);
          }
        }
      }
      collectMatchingContainers(document);
    }
    const container = matchingContainers[0] ?? document.body;
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
      totalHosts: collected.length,
      containerText: container ? deepText(container).trim().slice(0, 1000) : "",
      hosts: resolvedHosts,
    }));
  }, { args: [containerSelector] });
}
