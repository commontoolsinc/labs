import { env, waitFor } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { dirname, join, resolve } from "@std/path";
import "../src/globals.ts";
import { Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { clickPierce } from "./shadow-dom.ts";
import { expect } from "@std/expect";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const decoder = new TextDecoder();

async function runCfPieceNewWithSlug(options: {
  sourcePath: string;
  identityPath: string;
  slug: string;
}): Promise<string> {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: REPO_ROOT,
    args: [
      "run",
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      "piece",
      "new",
      options.sourcePath,
      "--identity",
      options.identityPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_NAME,
      "--slug",
      options.slug,
    ],
    env: {
      CF_LOG_LEVEL: "error",
    },
  });
  const result = await command.output();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  if (!result.success) {
    throw new Error(
      `cf piece new failed with ${result.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const pieceId = stdout.match(/fid1:[^\s]+/)?.[0];
  if (!pieceId) {
    throw new Error(`cf piece new did not print a fid1 id:\n${stdout}`);
  }
  return pieceId;
}

async function writeIdentityKey(identity: Identity): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "shell-slug-piece-" });
  const path = join(dir, "identity.key");
  await Deno.writeFile(path, identity.toPkcs8());
  return path;
}

async function waitForSlugPieceMarker(
  shell: ShellIntegration,
  expectedText: string,
): Promise<void> {
  await waitFor(async () => {
    return await shell.page().evaluate((expected) => {
      function findText(root: Document | ShadowRoot): string | undefined {
        const marker = root.querySelector("#slug-piece-marker");
        if (marker?.textContent?.trim()) {
          return marker.textContent.trim();
        }
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) {
            const found = findText(element.shadowRoot);
            if (found) return found;
          }
        }
      }
      return findText(document) === expected;
    }, { args: [expectedText] });
  });
}

async function getClientEngineCompileCount(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<number> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) {
      throw new Error("Runtime client was not exposed");
    }
    const { timing } = await rt.getLoggerCounts();
    return timing.engine?.compile?.count ?? 0;
  });
}

async function waitForSpaceRootPattern(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<void> {
  await waitFor(async () => {
    return await page.evaluate(() => {
      const rootView = document.querySelector("x-root-view");
      const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
        | {
          _patterns?: {
            value?: {
              spaceRootPattern?: {
                id(): string;
              };
            };
          };
        }
        | null;
      return !!appView?._patterns?.value?.spaceRootPattern?.id?.();
    });
  });
}

describe("shell piece tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can view and interact with a piece", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    let piece: PieceController | undefined;
    let pieceSinkCancel: (() => void) | undefined;
    let identityPath: string | undefined;
    const logDebugSnapshot = async (label: string) => {
      console.log(label, {
        shellState: await shell.state(),
        pieceValue: piece ? await piece.result.get(["value"]) : undefined,
        clientEngineCompileCount: await getClientEngineCompileCount(page)
          .catch((error) => error instanceof Error ? error.message : error),
        page: await page.evaluate(() => {
          const rootView = document.querySelector("x-root-view");
          const typedRootView = rootView as
            | {
              _rt?: {
                status?: unknown;
                value?: unknown;
                error?: {
                  message?: string;
                };
              };
              app?: {
                identity?: unknown;
              };
            }
            | null;
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                status?: unknown;
                value?: {
                  activePattern?: {
                    id(): string;
                  };
                };
              };
              _selectedPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
              };
              _spaceRootPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
              };
              _patternError?: {
                message?: string;
              };
            }
            | null;
          return {
            href: globalThis.location.href,
            hasRuntime: !!globalThis.commonfabric?.rt,
            hasRootView: !!rootView,
            rootRuntimeStatus: typedRootView?._rt?.status,
            hasRootRuntimeValue: !!typedRootView?._rt?.value,
            rootRuntimeError: typedRootView?._rt?.error?.message,
            rootHasIdentity: !!typedRootView?.app?.identity,
            hasAppView: !!appView,
            patternsStatus: appView?._patterns?.status,
            selectedPatternStatus: appView?._selectedPattern?.status,
            spaceRootPatternStatus: appView?._spaceRootPattern?.status,
            activePatternId: appView?._patterns?.value?.activePattern?.id?.(),
            selectedPatternId: appView?._selectedPattern?.value?.id?.(),
            spaceRootPatternId: appView?._spaceRootPattern?.value?.id?.(),
            patternError: appView?._patternError?.message,
            bodyText: document.body.textContent?.trim().slice(0, 200),
          };
        }),
      });
    };

    try {
      const sourcePath = join(
        import.meta.dirname!,
        "..",
        "..",
        "patterns",
        "counter",
        "counter.tsx",
      );
      identityPath = await writeIdentityKey(identity);
      const slug = `compile-cache-${crypto.randomUUID()}`;
      const pieceId = await runCfPieceNewWithSlug({
        sourcePath,
        identityPath,
        slug,
      });
      const currentPiece = await cc.get(pieceId, false);
      piece = currentPiece;

      const resultCell = cc.manager().getResult(currentPiece.getCell());
      pieceSinkCancel = resultCell.sink(() => {});

      await waitFor(async () =>
        (await currentPiece.result.get(["value"])) === 0
      );
      await waitFor(async () => {
        const reloadedPiece = await cc.get(pieceId, true);
        return (await reloadedPiece.result.get(["value"])) === 0;
      });
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
        },
        identity,
      });

      await waitFor(async () => {
        return await page.evaluate(() => !!globalThis.commonfabric?.rt);
      });
      await waitForSpaceRootPattern(page);
      // First in-browser load of the piece: pieces are no longer eagerly
      // started when the space loads (CT-1623 — the header used to start every
      // piece just to label its menu), so this navigation performs the cold
      // in-client compile and seeds the compilation cache. The cache contract
      // is asserted below against a fresh worker.
      await page.evaluate(async (spaceName, pieceId) => {
        await globalThis.app.setView({ spaceName, pieceId });
      }, { args: [SPACE_NAME, pieceId] });
      await shell.waitForState({
        view: {
          spaceName: SPACE_NAME,
          pieceSlug: slug,
        },
        identity,
      });

      const waitForActivePattern = async () => {
        await waitFor(async () => {
          return await page.evaluate((expectedPieceId) => {
            const rootView = document.querySelector("x-root-view");
            const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
              | {
                _patterns?: {
                  value?: {
                    activePattern?: {
                      id(): string;
                    };
                  };
                };
              }
              | null;
            const activePattern = appView?._patterns?.value?.activePattern;
            return activePattern?.id() === expectedPieceId;
          }, { args: [pieceId] });
        });
      };

      await waitForActivePattern();

      await waitFor(async () =>
        (await currentPiece.result.get(["value"])) === 0
      );

      await clickPierce(page, "#counter-decrement");
      await waitFor(async () =>
        (await currentPiece.result.get(["value"])) === -1
      );

      await clickPierce(page, "#counter-decrement");
      await waitFor(async () =>
        (await currentPiece.result.get(["value"])) === -2
      );

      // Compilation-cache contract: the piece's cold compile above was written
      // back to the IDB-backed CachedCompiler. A FRESH worker must then load
      // the piece from that cache — zero in-client compilations during the
      // piece load. Flush the write-backs first: a write still in flight when
      // the fresh worker reads the cache forces a recompile (the flake this
      // guard exists for).
      await page.evaluate(async () => {
        await globalThis.commonfabric?.rt?.flushCompileCacheWrites();
      });
      await page.evaluate(async () => {
        try {
          await globalThis.commonfabric?.rt?.dispose();
        } finally {
          if (globalThis.commonfabric) globalThis.commonfabric.rt = undefined;
        }
      });
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
        },
        identity,
      });
      await waitFor(async () => {
        return await page.evaluate(() => !!globalThis.commonfabric?.rt);
      });
      await waitForSpaceRootPattern(page);
      // Settle the space-root chain's own loads before baselining (a trailing
      // root compile landing inside the measurement window would show up as a
      // false piece recompile): drain the scheduler, then the compile-cache
      // write-backs — both deterministic completion signals, no timed waits.
      await page.evaluate(async () => {
        await globalThis.commonfabric?.rt?.idle();
        await globalThis.commonfabric?.rt?.flushCompileCacheWrites();
      });
      const compileCountBeforePieceLoad = await getClientEngineCompileCount(
        page,
      );
      await page.evaluate(async (spaceName, pieceId) => {
        await globalThis.app.setView({ spaceName, pieceId });
      }, { args: [SPACE_NAME, pieceId] });
      await shell.waitForState({
        view: {
          spaceName: SPACE_NAME,
          pieceSlug: slug,
        },
        identity,
      });
      await waitForActivePattern();
      const compileCountAfterPieceLoad = await getClientEngineCompileCount(
        page,
      );
      if (compileCountAfterPieceLoad !== compileCountBeforePieceLoad) {
        throw new Error(
          `Expected 0 in-client compilations while a fresh worker loads the ` +
            `cached cf-created piece ${pieceId}; engine compile count ` +
            `changed from ${compileCountBeforePieceLoad} to ` +
            `${compileCountAfterPieceLoad}`,
        );
      }

      await waitFor(async () =>
        (await currentPiece.result.get(["value"])) === -2
      );
    } catch (error) {
      if (piece) {
        await logDebugSnapshot("shell piece test debug");
      }
      throw error;
    } finally {
      pieceSinkCancel?.();
      await shell.disposeRuntime();
      await cc.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (identityPath) {
        await Deno.remove(dirname(identityPath), { recursive: true }).catch(
          () => {},
        );
      }
    }
  });

  it("loads a slug piece and reloads when cf piece new repoints the slug", async () => {
    const slug = `slug-repoint-${crypto.randomUUID()}`;
    const identity = await Identity.generate({ implementation: "noble" });
    const identityPath = await writeIdentityKey(identity);
    const identityDir = dirname(identityPath);
    const firstSource = join(
      import.meta.dirname!,
      "fixtures",
      "slug-piece-v1.tsx",
    );
    const secondSource = join(
      import.meta.dirname!,
      "fixtures",
      "slug-piece-v2.tsx",
    );

    try {
      const firstPieceId = await runCfPieceNewWithSlug({
        sourcePath: firstSource,
        identityPath,
        slug,
      });

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceSlug: slug,
        },
        identity,
      });
      await waitForSlugPieceMarker(shell, "slug piece v1");
      await shell.waitForState({
        view: {
          spaceName: SPACE_NAME,
          pieceSlug: slug,
        },
        identity,
      });

      const secondPieceId = await runCfPieceNewWithSlug({
        sourcePath: secondSource,
        identityPath,
        slug,
      });
      expect(secondPieceId).not.toBe(firstPieceId);

      await waitForSlugPieceMarker(shell, "slug piece v2");
      const href = await shell.page().evaluate(() => globalThis.location.href);
      expect(href).toContain(`/${SPACE_NAME}/${slug}`);
    } finally {
      await Deno.remove(identityDir, { recursive: true });
    }
  });
});
