import {
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import {
  CLICK_TARGET_ATTR,
  clickMarked,
  settleView,
} from "./cfc-browser-helpers.ts";

// Find-and-click-a-button-by-text helpers shared by the default-app
// integration tests. The predicate below stamps the button it resolved with
// CLICK_TARGET_ATTR, and clickMarked then resolves that exact element and
// dispatches a single trusted click on it. The predicate is what this module
// adds: it picks a button by its text, its exact text, or its title, where the
// predicates in cfc-browser-helpers.ts pick one by CSS selector, by index
// within a selector, or by data-ui-action value.

// Serialized into the page by waitForCondition: find the first rendered
// button/link whose text or title matches and stamp its inner click target with
// `token`. "Rendered" means laid out and not display:none/visibility:hidden —
// the same elements the innerText scan the poll used could see — and is
// viewport-independent, so a match below the fold is still tagged: the click
// scrolls the element into view itself. Returns false until a match exists, so
// the wait re-checks on the next DOM mutation instead of the caller retrying a
// bare find-and-click loop. Self-contained — it closes over nothing in this
// module — so it can be serialized and run in the page.
const markNoteButton = (
  probe: ProbeApi,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
  token: string,
  attr: string,
): boolean => {
  const target = probe.collect(selector).find((element) => {
    if (!probe.isRendered(element)) return false;
    if (match === "title") return element.getAttribute("title") === needle;
    const text = (element.textContent ?? "").trim();
    return match === "exact" ? text === needle : text.includes(needle);
  }) as HTMLElement | undefined;
  if (!target) return false;
  const clickTarget = (target.shadowRoot?.querySelector("[data-cf-button]") as
    | HTMLElement
    | null) ?? target;
  if (!clickTarget.isConnected || !probe.isRendered(clickTarget)) return false;
  probe.addToken(clickTarget, attr, token);
  return true;
};

// Settle the view, tag a matching button, and dispatch a single trusted click
// on it. Throws if no matching button becomes clickable.
async function settleAndClickNoteButton(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<void> {
  // Settle before tagging so the tagged button is the final rendered node, laid
  // out and still attached when the click resolves its box model.
  await settleView(page);
  const token = `cfc-note-button-${crypto.randomUUID()}`;
  try {
    await waitForCondition(page, markNoteButton, {
      args: [selector, match, needle, token, CLICK_TARGET_ATTR],
    });
  } catch (cause) {
    throw new Error(
      `Unable to find a ${
        match === "title" ? "button titled" : "button matching"
      } "${needle}" to click`,
      { cause },
    );
  }
  await clickMarked(page, {
    token,
    remark: {
      predicate: markNoteButton,
      args: [selector, match, needle, token, CLICK_TARGET_ATTR],
    },
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
