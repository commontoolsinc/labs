import { css, html } from "lit";
import { BaseElement } from "./base-element.ts";

/**
 * Retired elements: inert passthrough stubs for components we have removed.
 *
 * Why this exists: a pattern's source is DURABLE. Pieces keep running the
 * source they were stored with, for as long as that piece lives — so the set
 * of element names patterns may emit is not "whatever the current palette
 * defines", it is the union of every palette that has ever shipped. Deleting a
 * component therefore does not retire it; it only removes the definition out
 * from under source that still names it.
 *
 * Removing `cf-cell-context` (#5132) demonstrated the cost. Stored home
 * sections still emitted it, and with both the component and its `jsx.d.ts`
 * declaration gone, rows that mapped over durable data stopped instantiating —
 * silently, because the failure surfaced as cell requests that never settled
 * rather than as an error. Blank Favorites and Profile tabs, nothing in the
 * console, for weeks.
 *
 * So a retired element keeps a definition that renders its children and does
 * nothing else. It stays a known element, its props keep their declared
 * meaning, and the subtree underneath it goes on working. It is loud rather
 * than fatal: one console warning per element per session at runtime, and an
 * `@deprecated` JSX declaration so authoring flags it at edit time. Patterns
 * get rewritten off it at their own pace; the stub leaves only when nothing
 * durable names it any more.
 */

const warned = new Set<string>();

/** Warn once per element name per session that durable source still uses it. */
export function warnRetiredElementUsed(
  tag: string,
  replacement?: string,
): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(
    `[retired-element] <${tag}> is retired and now renders as an inert ` +
      `passthrough. Durable pattern source still names it` +
      (replacement ? `; use ${replacement} instead.` : ".") +
      ` Update the pattern's source to stop relying on it.`,
  );
}

/** Reset the warn-once ledger. Test seam only. */
export function resetRetiredElementWarnings(): void {
  warned.clear();
}

/**
 * Base class for a retired element: renders a default slot, nothing else.
 *
 * Subclasses declare their own tag name and any props the retired component
 * carried, so source that binds those props still type-checks and still hands
 * the runtime the same declarations (a `$cell` binding must keep meaning "a
 * cell", or the schema derived for the surrounding row changes).
 */
export abstract class RetiredElement extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: contents;
      }
    `,
  ];

  /** The tag this stub stands in for. */
  protected abstract retiredTag: string;
  /** What to use instead, when there is a successor. */
  protected retiredReplacement?: string;

  override connectedCallback(): void {
    super.connectedCallback();
    warnRetiredElementUsed(this.retiredTag, this.retiredReplacement);
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
