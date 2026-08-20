import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { Browser } from "../browser.ts";
import type { Page } from "../page.ts";
import {
  assertShellDocument,
  describeShellPage,
  readShellPageProbe,
} from "../shell-page-probe.ts";
import { describeStateWaitFailure } from "../shell-utils.ts";

// What the toolshed answers with when its fetch to the shell dev server fails.
const PROXY_FAILURE_TEXT =
  "Failed to proxy to http://localhost:6000/. Is the shell dev server running?";

// The part of the shell's entry document that matters here: a title, and the
// root element every shell wait afterwards depends on.
const SHELL_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view></body></html>`;

// The same document with the shell already booted far enough to have published
// itself, holding the home view and an identity.
const BOOTED_SHELL_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.app = {
    serialize: () => ({
      view: { builtin: "home" },
      identity: { privateKey: [1, 2, 3] },
    }),
  };
</script>
</body></html>`;

function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/proxy-failure":
      return new Response(PROXY_FAILURE_TEXT, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "/shell":
      return new Response(SHELL_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/booted-shell":
      return new Response(BOOTED_SHELL_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
  }
  return new Response("not found", { status: 404 });
}

// The message of the error `work` rejects with. Fails the test when it
// resolves, so a check on the message cannot pass vacuously.
async function rejectionMessage(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the call to throw, and it returned instead.");
}

describe("shell-failure-reports", () => {
  let server: Deno.HttpServer;
  let origin: string;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = Deno.serve({ port: 0, onListen: () => {} }, handle);
    origin = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
    browser = await Browser.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
    await server.shutdown();
  });

  // Loads `path` from the local server and installs the console formatter,
  // which is the state `ShellIntegration.goto` leaves a page in before it
  // starts waiting.
  const load = async (path: string): Promise<string> => {
    const url = `${origin}${path}`;
    await page.goto(url);
    await page.applyConsoleFormatter();
    return url;
  };

  describe("readShellPageProbe()", () => {
    it("returns the status and text of a document that is not the shell", async () => {
      await load("/proxy-failure");

      const probe = await readShellPageProbe(page);
      expect(probe.rootView).toBe(false);
      expect(probe.app).toBe(false);
      expect(probe.status).toBe(502);
      expect(probe.text).toBe(PROXY_FAILURE_TEXT);
    });

    it("returns the title and root element of the shell's own document", async () => {
      await load("/shell");

      const probe = await readShellPageProbe(page);
      expect(probe.rootView).toBe(true);
      expect(probe.title).toBe("Common Fabric");
      expect(probe.status).toBe(200);
      // Nothing has booted, so nothing has published `globalThis.app`.
      expect(probe.app).toBe(false);
    });

    it("returns the view and identity a booted shell holds", async () => {
      await load("/booted-shell");

      const probe = await readShellPageProbe(page);
      expect(probe.app).toBe(true);
      expect(probe.view).toEqual({ builtin: "home" });
      expect(probe.identity).toBe(true);
    });

    it("returns the console messages the page retained", async () => {
      await load("/booted-shell");
      await page.evaluate(() => {
        console.warn("the page said something before the wait gave up");
      });

      const probe = await readShellPageProbe(page);
      expect(probe.consoleTail.length).toBe(1);
      expect(probe.consoleTail[0]).toContain(
        "[warn] the page said something before the wait gave up",
      );
    });
  });

  describe("assertShellDocument()", () => {
    it("throws naming the document that loaded instead of the shell", async () => {
      const url = await load("/proxy-failure");

      const message = await rejectionMessage(assertShellDocument(page, url));
      expect(message).toContain(
        "the document that loaded is not the shell: it has no x-root-view",
      );
      expect(message).toContain("response status: 502");
      expect(message).toContain("globalThis.app: absent");
      expect(message).toContain(
        "document text: Failed to proxy to http://localhost:6000/",
      );
    });

    it("returns for the shell's own document", async () => {
      const url = await load("/shell");

      await assertShellDocument(page, url);
    });
  });

  describe("describeShellPage()", () => {
    it("returns a block naming the view and identity the page holds", async () => {
      await load("/booted-shell");

      const described = describeShellPage(await readShellPageProbe(page));
      expect(described).toContain(
        'globalThis.app: present, holding view {"builtin":"home"} and an identity',
      );
      expect(described).toContain("x-root-view: present");
    });

    it("omits the document's text for a page that is the shell", async () => {
      await load("/shell");

      const described = describeShellPage(await readShellPageProbe(page));
      expect(described).not.toContain("document text:");
    });
  });

  describe("describeStateWaitFailure()", () => {
    it("returns a block naming the awaited view beside the view held", async () => {
      await load("/booted-shell");

      const described = await describeStateWaitFailure(
        page,
        { view: { spaceName: "some-space" } },
        undefined,
      );
      expect(described).toContain('awaited view: {"spaceName":"some-space"}');
      expect(described).toContain(
        "last state read: none (the page never yielded a state)",
      );
      expect(described).toContain(
        'globalThis.app: present, holding view {"builtin":"home"}',
      );
    });

    it("names both identity DIDs when an identity was awaited", async () => {
      await load("/booted-shell");

      const awaited = await Identity.generate();
      const held = await Identity.generate();
      const described = await describeStateWaitFailure(
        page,
        { view: { builtin: "home" }, identity: awaited },
        {
          view: { builtin: "home" },
          identity: held,
          apiUrl: new URL(origin),
          config: {},
        },
      );
      expect(described).toContain(`awaited identity: ${awaited.did()}`);
      expect(described).toContain(
        `last state read: view {"builtin":"home"}, identity ${held.did()}`,
      );
    });

    it("names a document that is not the shell", async () => {
      await load("/proxy-failure");

      const described = await describeStateWaitFailure(
        page,
        { view: { builtin: "home" } },
        undefined,
      );
      expect(described).toContain("x-root-view: absent");
      expect(described).toContain("globalThis.app: absent");
      expect(described).toContain("response status: 502");
      expect(described).toContain("document text: Failed to proxy to ");
    });
  });
});
