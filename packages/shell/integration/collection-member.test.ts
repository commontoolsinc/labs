/**
 * The shell opening `/<space>/<collection>/<member>` in a browser, over a real
 * board filed by `cf`.
 *
 * What is proven here and nowhere else is the whole chain standing up at once:
 * a slug bound inside a piece, a worker resolving the reference through it,
 * and a rendered page that is the member rather than the board.
 */

import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import "../src/globals.ts";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const BOARD_SOURCE = join(
  REPO_ROOT,
  "packages",
  "patterns",
  "collection-naming",
  "board.tsx",
);
const decoder = new TextDecoder();

/**
 * Run one `cf` command against the space these tests share. The identity and
 * server flags land between `args` and `tail`, because a callable name opens
 * the section its own arguments sit in: `cf piece call` reads everything past
 * the name as the handler's input.
 */
async function cf(
  identityPath: string,
  args: string[],
  tail: string[] = [],
): Promise<string> {
  // Through the temporary lock, because a nested Deno resolves dependencies
  // of its own and would refresh the repository's `deno.lock` as a side
  // effect of a test that only means to read a board back.
  const result = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--lock",
      lockPath,
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      ...args,
      "--identity",
      identityPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_NAME,
      ...tail,
    ],
    env: { CF_LOG_LEVEL: "error" },
  });
  const stdout = decoder.decode(result.stdout);
  if (!result.success) {
    throw new Error(
      `cf ${args.join(" ")} failed with ${result.code}\nstdout:\n${stdout}` +
        `\nstderr:\n${decoder.decode(result.stderr)}`,
    );
  }
  return stdout;
}

/**
 * File the exemplar board, give it one member per title, and bind `slug` to
 * the map it keeps them in. That binding is what makes `<slug>/<member>` an
 * address: the slug points inside the board rather than at its root, which is
 * what tells a resolver it names a collection.
 */
async function fileBoardWithMembers(
  identityPath: string,
  slug: string,
  titles: readonly string[],
): Promise<string> {
  const created = await cf(identityPath, ["piece", "new", BOARD_SOURCE]);
  const boardId = created.match(/fid1:[^\s]+/)?.[0];
  if (!boardId) {
    throw new Error(`cf piece new did not print a fid1 id:\n${created}`);
  }
  for (const title of titles) {
    await cf(
      identityPath,
      ["piece", "call", "--cell", `/of:${boardId}`],
      ["addItem", JSON.stringify({ title, agentName: "shell integration" })],
    );
  }
  await cf(identityPath, [
    "piece",
    "set-slug",
    slug,
    `/of:${boardId}/names`,
  ]);
  return boardId;
}

describe("shell collection members", () => {
  // Two suites because they tolerate different things. Opening a member must
  // record no console error at all; only the suite whose subject IS a failed
  // load allows the one that failure reports, so a regression breaking the
  // happy path cannot hide inside an allowance written for the other.
  describe("opening one", () => {
    const shell = new ShellIntegration();
    shell.bindLifecycle();

    it("opens the member a collection reference names", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `members-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identityPath, slug, [
        "Glaze recipes",
        "Oven schedule",
      ]);

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "2" },
        identity,
      });

      // One badge, reading the board's name for this member. The board
      // renders one per item, so a page carrying exactly one is the member's.
      await waitForCondition(shell.page(), (probe) => {
        const badges = probe.collect("[data-member-name]");
        return badges.length === 1 && probe.deepText(badges[0]).trim() === "2";
      });
      // The tab names the piece the shell opened. Member 2 is the second item
      // filed, and the board would name itself for its item count instead.
      await waitForCondition(
        shell.page(),
        () => document.title === "Oven schedule",
      );
    });

    it("opens the reference the header hands out", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `portable-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identityPath, slug, [
        "Glaze recipes",
        "Oven schedule",
      ]);

      // `/@<space>/<collection>/<member>` is what "Copy reference" copies, and
      // a page served at that URL is the only place its whole trip is
      // visible: through the server that routes it, the browser that sends
      // it, and the shell that reads it back.
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "2" },
        urlPath: `/@${SPACE_NAME}/${slug}/2`,
        identity,
      });

      await waitForCondition(shell.page(), (probe) => {
        const badges = probe.collect("[data-member-name]");
        return badges.length === 1 && probe.deepText(badges[0]).trim() === "2";
      });
      // The mark says which segment is the space and is no part of it, so the
      // page the shell settles on is the one it would have written itself.
      const pathname = await shell.page().evaluate(() =>
        globalThis.location.pathname
      );
      expect(pathname).toBe(`/${SPACE_NAME}/${slug}/2`);
    });
  });

  describe("naming one that is not there", () => {
    const shell = new ShellIntegration({
      allowedConsoleErrors: ["[AppView] Failed to load selected piece:"],
    });
    shell.bindLifecycle();

    it("reports a member the collection does not hold, naming both", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `missing-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identityPath, slug, ["Glaze recipes"]);

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "999" },
        identity,
      });

      await waitForCondition(
        shell.page(),
        (probe, expected: string) =>
          probe.collect(".load-error").some((element) => {
            const text = probe.deepText(element).replace(/\s+/g, " ").trim();
            return text.includes("We could not load this piece") &&
              text.includes(expected);
          }),
        { args: [`no member 999 in ${slug}`] },
      );
    });
  });
});
