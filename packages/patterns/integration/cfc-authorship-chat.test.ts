import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc authorship chat integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: Awaited<ReturnType<PiecesController["create"]>>;
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
      "cfc-authorship-chat",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("renders trusted avatars only for content whose author claim matches integrity", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForAuthorshipStates(page, {
      verified: "verified",
      forged: "unverified",
      unsigned: "unknown",
    });
  });
});

async function waitForAuthorshipStates(
  page: Page,
  expected: Record<string, "verified" | "unverified" | "unknown">,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitFor(async () => {
      probe = await readAuthorshipProbe(page);
      return Object.entries(expected).every(([surface, state]) =>
        probe?.hosts.some((host) =>
          host.surface === surface &&
          host.state === state &&
          (state === "verified"
            ? host.hasTrustedAvatar
            : !host.hasTrustedAvatar)
        )
      );
    }, { timeout: 15_000 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for CFC authorship states. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

type AuthorshipProbe = {
  registered: boolean;
  hosts: Array<{
    surface: string | null;
    state: string | undefined;
    shadowText: string;
    hasTrustedAvatar: boolean;
  }>;
};

async function readAuthorshipProbe(page: Page): Promise<AuthorshipProbe> {
  return await page.evaluate(() => {
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

    const elements: Element[] = [];
    collect(document, elements);
    const hosts = elements.map((element) => {
      const state = (element as unknown as { authorshipState?: string })
        .authorshipState;
      return {
        surface: element.getAttribute("data-authorship-surface"),
        state,
        shadowText: element.shadowRoot?.textContent ?? "",
        hasTrustedAvatar:
          element.shadowRoot?.querySelector("[data-cfc-authorship-avatar]") !==
            null,
      };
    });

    return {
      registered: customElements.get("cf-cfc-authorship") !== undefined,
      hosts,
    };
  });
}
