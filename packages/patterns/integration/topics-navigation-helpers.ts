/**
 * Driving the shell's piece-to-piece navigation from a browser: resolve a
 * rendered `cf-cell-link`, click it, and wait for the destination view.
 */

import {
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import {
  CLICK_TARGET_ATTR,
  clickMarked,
  settleView,
} from "./cfc-browser-helpers.ts";

/** Attribute naming the link a mark resolved, so its target can be read back. */
const LINK_TARGET_ATTR = "data-topics-link-target";

/**
 * Find the resolved `cf-cell-link` labelled `targetLabel` and tag both it and
 * the native button inside it with `targetToken`. Self-contained: it is
 * serialized and run in the page, so it closes over nothing in this module.
 *
 * A link counts as resolved once it carries the address it points at and the
 * cell behind that address, and its button has been laid out. A link that is
 * still forming has a label and no destination.
 */
const markCellLink = (
  probe: ProbeApi,
  targetLabel: string,
  targetToken: string,
  clickTargetAttribute: string,
  linkTargetAttribute: string,
): boolean => {
  for (const element of probe.collect("cf-cell-link")) {
    const link = element as HTMLElement & {
      label?: string;
      link?: string;
      _resolvedCell?: unknown;
    };
    if (link.label !== targetLabel || !link.link || !link._resolvedCell) {
      continue;
    }
    const chip = link.shadowRoot?.querySelector("cf-chip");
    const button = chip?.shadowRoot?.querySelector("button");
    if (!button || !probe.isRendered(button)) continue;
    link.setAttribute(linkTargetAttribute, targetToken);
    probe.addToken(button, clickTargetAttribute, targetToken);
    return true;
  }
  return false;
};

/**
 * Wait for a resolved cf-cell-link, mark its native button, then issue one
 * trusted browser click. Returning the link's fid lets the caller confirm the
 * shell selected exactly the destination represented by the rendered data.
 *
 * The view is settled before marking, so the link is resolved against a page
 * that has caught up rather than one mid-render. `clickMarked` carries the rest:
 * it holds until the marked button's box stops moving, measures again just
 * before dispatch, and is handed the mark predicate so a link the page rebuilds
 * in between is tagged again on whatever replaced it.
 */
export async function clickCellLink(
  page: Page,
  label: string,
): Promise<string> {
  await settleView(page);
  const token = `topics-cell-link-${crypto.randomUUID()}`;
  const markArgs: [string, string, string, string] = [
    label,
    token,
    CLICK_TARGET_ATTR,
    LINK_TARGET_ATTR,
  ];
  await waitForCondition(page, markCellLink, { args: markArgs });

  const target = await page.evaluate(
    (targetToken: string, linkTargetAttribute: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length > 0) {
        const root = stack.pop()!;
        const found = root.querySelector(
          `[${linkTargetAttribute}="${targetToken}"]`,
        ) as (HTMLElement & { link?: string }) | null;
        if (found?.link) return found.link;
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) stack.push(element.shadowRoot);
        }
      }
      return undefined;
    },
    { args: [token, LINK_TARGET_ATTR] },
  );
  if (!target?.startsWith("/of:")) {
    throw new Error(`Cell link "${label}" had invalid target: ${target}`);
  }

  await clickMarked(page, {
    token,
    remark: { predicate: markCellLink, args: markArgs },
  });
  return target.slice(1);
}

/**
 * Wait until the shell's selected view is `pieceId` in `spaceName`. A piece is
 * addressed both bare (`fid1:…`, as a URL carries it) and in storage form
 * (`of:fid1:…`, as a rendered link carries it); either spelling is accepted on
 * both sides of the comparison.
 */
export async function waitForPieceView(
  page: Page,
  spaceName: string,
  pieceId: string,
): Promise<void> {
  await waitForCondition(
    page,
    (_probe, expectedSpaceName: string, expectedPieceId: string) => {
      const fid = (id: string | undefined) =>
        id === undefined ? undefined : id.replace(/^of:/, "");
      const state = globalThis.app?.serialize() as
        | { view?: { spaceName?: string; pieceId?: string } }
        | undefined;
      return state?.view?.spaceName === expectedSpaceName &&
        fid(state.view.pieceId) === fid(expectedPieceId);
    },
    { args: [spaceName, pieceId] },
  );
}
