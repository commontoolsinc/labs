import {
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";

// Find-and-click-a-button-by-text helpers shared by the default-app
// integration tests. A click predicate stamps the button it resolved with a
// marker attribute, so the test can then resolve that exact element and
// dispatch a single trusted click on it. Mirrors the CLICK_TARGET_ATTR flow of
// clickCfButton in cfc-browser-helpers.ts.
const NOTE_BUTTON_CLICK_TARGET_ATTR = "data-cfc-note-button-target";

// Serialized into the page by waitForCondition: find the first rendered
// button/link whose text or title matches, scroll it into view, and stamp its
// inner click target with `token`. "Rendered" means laid out and not
// display:none/visibility:hidden — the same elements the innerText scan the
// poll used could see — and is viewport-independent, so a match below the fold
// is scrolled in rather than skipped. Returns false until a match exists, so
// the wait re-checks on the next DOM mutation instead of the caller retrying a
// bare find-and-click loop. Self-contained — it closes over nothing in this
// module — so it can be serialized and run in the page.
const markNoteButton = async (
  probe: ProbeApi,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
  token: string,
  attr: string,
): Promise<boolean> => {
  const target = probe.collect(selector).find((element) => {
    if (!probe.isRendered(element)) return false;
    if (match === "title") return element.getAttribute("title") === needle;
    const text = (element.textContent ?? "").trim();
    return match === "exact" ? text === needle : text.includes(needle);
  }) as HTMLElement | undefined;
  if (!target) return false;
  target.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const clickTarget = (target.shadowRoot?.querySelector("[data-cf-button]") as
    | HTMLElement
    | null) ?? target;
  if (!clickTarget.isConnected || !probe.isRendered(clickTarget)) return false;
  clickTarget.setAttribute(attr, token);
  return true;
};

// Remove every element carrying `attr=token`, descending through shadow roots.
async function clearNoteButtonMark(
  page: Page,
  token: string,
): Promise<void> {
  await page.evaluate((targetToken, targetAttr) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute(targetAttr) === targetToken) {
          result.push(element);
        }
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }
    const matches: Element[] = [];
    collect(document, matches);
    for (const element of matches) element.removeAttribute(targetAttr);
  }, { args: [token, NOTE_BUTTON_CLICK_TARGET_ATTR] }).catch(() => {});
}

// Wait for a matching button to be present and interactive, then dispatch a
// single trusted click on it. Throws if no matching button becomes clickable.
async function settleAndClickNoteButton(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<void> {
  const markTarget = async (token: string) => {
    await waitForCondition(page, markNoteButton, {
      args: [selector, match, needle, token, NOTE_BUTTON_CLICK_TARGET_ATTR],
    });
  };

  let token = `cfc-note-button-${crypto.randomUUID()}`;
  try {
    await markTarget(token);
  } catch (cause) {
    throw new Error(
      `Unable to find a ${
        match === "title" ? "button titled" : "button matching"
      } "${needle}" to click`,
      { cause },
    );
  }

  let lastCause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const clickTarget = await page.waitForSelector(
        `[${NOTE_BUTTON_CLICK_TARGET_ATTR}="${token}"]`,
        { strategy: "pierce" },
      );
      await clickTarget.click();
      return;
    } catch (cause) {
      lastCause = cause;
      const retryable = cause instanceof Error &&
        cause.message.includes("stable box model");
      if (!retryable || attempt === 2) break;
    } finally {
      await clearNoteButtonMark(page, token);
    }

    // A root-pattern hot swap can replace the marked button after discovery
    // but before Astral resolves its box. Re-mark the current rendered node and
    // retry the coordinate click; only the successful attempt dispatches.
    token = `cfc-note-button-${crypto.randomUUID()}`;
    await markTarget(token);
  }

  throw new Error(`Unable to click the stable "${needle}" button`, {
    cause: lastCause,
  });
}

// The click helpers resolve `true` once the single click has landed (they throw
// otherwise), so the call sites that assert the click succeeded keep reading.
export async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "includes",
    searchText,
  );
  return true;
}

export async function clickButtonWithExactText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "exact",
    searchText,
  );
  return true;
}

export async function clickButtonWithTitle(
  page: Page,
  title: string,
): Promise<boolean> {
  await settleAndClickNoteButton(page, "cf-button, button", "title", title);
  return true;
}

export async function findButtonWithText(
  page: Page,
  searchText: string,
): Promise<any | null> {
  try {
    const buttons = await page.$$("cf-button, button, a", {
      strategy: "pierce",
    });
    for (const button of buttons) {
      const text = await button.innerText();
      if (text?.trim().includes(searchText)) return button;
    }
    return null;
  } catch (_) {
    return null;
  }
}
