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
 * Find the resolved `cf-cell-link` showing `targetLabel` and tag both it and
 * the native button inside it with `targetToken`. Self-contained: it is
 * serialized and run in the page, so it closes over nothing in this module.
 *
 * A link is named by what it shows: its authored `label` when it carries one,
 * and otherwise the `[NAME]` of the cell it points at. It counts as resolved
 * once it holds that cell and its button has been laid out. A link that is
 * still forming shows a name and has resolved nothing.
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
      _name?: string;
      _resolvedCell?: unknown;
    };
    if ((link.label ?? link._name) !== targetLabel || !link._resolvedCell) {
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
 * trusted browser click. Returning the id of the cell the link resolved lets
 * the caller confirm the shell selected exactly the destination the rendered
 * data points at.
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
        ) as
          | (HTMLElement & {
            _resolvedCell?: {
              id(): string;
              ref(): { path: readonly unknown[] };
            };
          })
          | null;
        const cell = found?._resolvedCell;
        if (cell) return { id: cell.id(), depth: cell.ref().path.length };
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) stack.push(element.shadowRoot);
        }
      }
      return undefined;
    },
    { args: [token, LINK_TARGET_ATTR] },
  );
  if (!target) {
    throw new Error(`Cell link "${label}" resolved no destination cell`);
  }
  // The shell selects a piece, so a link the click can follow addresses a cell
  // root. Saying so here names the link that points inside one; the click
  // itself would only report that navigation never happened.
  if (target.depth > 0) {
    throw new Error(
      `Cell link "${label}" points ${target.depth} step(s) inside ${target.id}, ` +
        "which is not a cell the shell can select",
    );
  }

  await clickMarked(page, {
    token,
    remark: { predicate: markCellLink, args: markArgs },
  });
  return target.id;
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
