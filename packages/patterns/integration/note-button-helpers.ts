import {
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import {
  clickMarked,
  markTargetsArgs,
  settleAndMarkTargets,
  settleView,
} from "./cfc-browser-helpers.ts";

// Find-and-click-a-button-by-text helpers shared by the default-app
// integration tests. What this module adds is the finder below: it picks a
// button by its text, its exact text, or its title, where the finders in
// cfc-browser-helpers.ts pick one by CSS selector, by index within a selector,
// or by data-ui-action value. Settling around the match, marking it, and
// clicking it are that module's shared step, which every marked click runs.

// Serialized into the page: the first rendered button or link whose text or
// title matches, reached through its host's shadow root when the host wraps the
// control that takes the click. "Rendered" means laid out and not
// display:none/visibility:hidden — the same elements the innerText scan the
// poll used could see — and is viewport-independent, so a match below the fold
// still qualifies: the click scrolls the element into view itself. Answers
// `undefined` until a match exists, so the wait re-checks on the next DOM
// mutation instead of the caller retrying a bare find-and-click loop.
// Self-contained — it closes over nothing in this module — so it can be
// serialized and run in the page.
const findNoteButton = (
  probe: ProbeApi,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): readonly HTMLElement[] | undefined => {
  const target = probe.collect(selector).find((element) => {
    if (!probe.isRendered(element)) return false;
    if (match === "title") return element.getAttribute("title") === needle;
    const text = (element.textContent ?? "").trim();
    return match === "exact" ? text === needle : text.includes(needle);
  }) as HTMLElement | undefined;
  if (!target) return undefined;
  return [
    (target.shadowRoot?.querySelector("[data-cf-button]") as
      | HTMLElement
      | null) ?? target,
  ];
};

// Settle around a matching button, tag it, and dispatch a single trusted click
// on it. Throws if no matching button becomes clickable.
async function settleAndClickNoteButton(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<void> {
  const token = `cfc-note-button-${crypto.randomUUID()}`;
  const args = markTargetsArgs(findNoteButton, [selector, match, needle], [
    token,
  ]);
  try {
    await waitForCondition(page, settleAndMarkTargets, { args });
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
    remark: { predicate: settleAndMarkTargets, args },
  });
  await settleView(page);
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
