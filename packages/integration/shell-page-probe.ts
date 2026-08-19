import type { Page } from "./page.ts";

// How much of the document's text a probe carries back. Enough to read a
// server's error page, short enough to stay one line of a failure report.
const TEXT_LIMIT = 500;

// How many of the retained console messages a probe carries back.
const CONSOLE_TAIL_LIMIT = 40;

/**
 * What a page held at the moment a shell navigation or state wait failed.
 *
 * Read with {@link readShellPageProbe} and rendered with
 * {@link describeShellPage}. Every field answers a question an investigator
 * asks of a failed shell test: is this the shell at all, did the server answer
 * with the document that was asked for, had the shell booted far enough to
 * publish itself, and what was it showing.
 */
export interface ShellPageProbe {
  /** The document's own URL, which a redirect can make differ from the one requested. */
  url: string;
  /** The document's title. */
  title: string;
  /**
   * HTTP status of the navigation response, taken from the page's navigation
   * timing entry. Absent for a document that came from no network response.
   */
  status?: number;
  /** Whether the shell's root element, `x-root-view`, is in the document. */
  rootView: boolean;
  /** Whether the shell has published itself on `globalThis.app`. */
  app: boolean;
  /** The view `globalThis.app` holds, read from its serialized state. */
  view?: unknown;
  /** Why that state could not be read, when `app` is set and reading it threw. */
  viewError?: string;
  /** Whether that state carries an identity. */
  identity?: boolean;
  /** The start of the document's rendered text. */
  text: string;
  /**
   * The console messages `Page.applyConsoleFormatter` retained in the page,
   * oldest first, each prefixed with how long before the probe it was logged.
   * Empty for a document the formatter was never applied to.
   */
  consoleTail: string[];
}

/** Read {@link ShellPageProbe} from the document currently in `page`. */
export async function readShellPageProbe(page: Page): Promise<ShellPageProbe> {
  return await page.evaluate((textLimit: number, tailLimit: number) => {
    const scope = globalThis as typeof globalThis & {
      app?: { serialize?: () => { view?: unknown; identity?: unknown } };
      __cfConsoleTail?: Array<{ t: number; method: string; text: string }>;
    };

    const navigation = performance.getEntriesByType("navigation")[0] as
      | (PerformanceNavigationTiming & { responseStatus?: number })
      | undefined;
    const status = typeof navigation?.responseStatus === "number"
      ? navigation.responseStatus
      : undefined;

    const app = typeof scope.app?.serialize === "function";
    let view: unknown;
    let viewError: string | undefined;
    let identity: boolean | undefined;
    if (app) {
      try {
        const state = scope.app!.serialize!();
        view = state.view;
        identity = !!state.identity;
      } catch (error) {
        viewError = String(error);
      }
    }

    const body = document.body;
    const text = (body?.innerText ?? body?.textContent ?? "").trim()
      .slice(0, textLimit);

    const now = Date.now();
    const consoleTail = (scope.__cfConsoleTail ?? []).slice(-tailLimit).map(
      (entry) => `${now - entry.t}ms ago [${entry.method}] ${entry.text}`,
    );

    return {
      url: location.href,
      title: document.title,
      status,
      rootView: !!document.querySelector("x-root-view"),
      app,
      view,
      viewError,
      identity,
      text,
      consoleTail,
    };
  }, { args: [TEXT_LIMIT, CONSOLE_TAIL_LIMIT] });
}

/**
 * Render `probe` as the indented block of detail lines that follows the first
 * line of a failure message.
 *
 * The document's text is included only when the document is not the shell.
 * For the shell it is the whole rendered application, which says less about a
 * stalled wait than the view and the console tail already do.
 */
export function describeShellPage(probe: ShellPageProbe): string {
  const lines: string[] = [
    `  document URL: ${probe.url}`,
    `  document title: ${probe.title || "(none)"}`,
  ];
  if (probe.status !== undefined) {
    lines.push(`  response status: ${probe.status}`);
  }
  lines.push(`  x-root-view: ${probe.rootView ? "present" : "absent"}`);
  if (probe.viewError !== undefined) {
    lines.push(
      `  globalThis.app: present, but reading its state threw: ${probe.viewError}`,
    );
  } else if (probe.app) {
    lines.push(
      `  globalThis.app: present, holding view ${JSON.stringify(probe.view)}` +
        ` and ${probe.identity ? "an identity" : "no identity"}`,
    );
  } else {
    lines.push("  globalThis.app: absent");
  }
  if (!probe.rootView) {
    const text = probe.text.replace(/\s+/g, " ");
    lines.push(`  document text: ${text || "(empty)"}`);
  }
  if (probe.consoleTail.length === 0) {
    lines.push("  console tail: empty");
  } else {
    lines.push(`  console tail (${probe.consoleTail.length} most recent):`);
    for (const entry of probe.consoleTail) lines.push(`    ${entry}`);
  }
  return lines.join("\n");
}

/**
 * Fail unless the document in `page` is the shell.
 *
 * The shell's entry document carries an `x-root-view` element, so a document
 * without one came from somewhere else: the toolshed's proxy failure page when
 * it cannot reach the shell dev server, a 404 from a server that serves no
 * shell, a browser error page. Everything a shell test waits for afterwards is
 * read through `globalThis.app`, which such a document never defines, so the
 * wait runs to its bound and reports only that time ran out. Checking here
 * reports the document that arrived instead, at the moment it arrived.
 */
export async function assertShellDocument(
  page: Page,
  requestedUrl: string,
): Promise<void> {
  const probe = await readShellPageProbe(page);
  if (probe.rootView) return;
  throw new Error(
    `Navigated to ${requestedUrl}, but the document that loaded is not the ` +
      `shell: it has no x-root-view element.\n${describeShellPage(probe)}`,
  );
}
