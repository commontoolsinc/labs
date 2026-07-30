import { RetiredElement } from "../../core/retired-element.ts";
import type { CellHandle } from "@commonfabric/runtime-client";
import { property } from "lit/decorators.js";

/**
 * CFCellContext — RETIRED (#5132), kept as an inert passthrough.
 *
 * The Alt-hold cell-region overlay this used to draw is gone; live-state
 * inspection lives in cf-piece-menu's Data and Actions panels now. What is
 * kept is the element itself, because durable pattern source still emits it:
 * home's Favorites section, among others, wraps each row in
 * `<cf-cell-context $cell={item.cell}>`, and those pieces keep running the
 * source they were stored with.
 *
 * The `cell` property is declared for the same reason. `$cell` must keep
 * meaning "this prop is a cell": that declaration feeds the schema derived for
 * the surrounding row, and dropping it is what made stored favorites fail
 * argument validation and hang.
 *
 * @element cf-cell-context
 * @deprecated Retired in #5132. Renders children and nothing else; use
 * cf-piece-menu for cell inspection. Stop emitting it from new patterns.
 */
export class CFCellContext extends RetiredElement {
  protected override retiredTag = "cf-cell-context";
  protected override retiredReplacement = "cf-piece-menu";

  /** Retained so `$cell` keeps its cell binding; otherwise unused. */
  @property({ attribute: false })
  accessor cell: CellHandle<unknown> | undefined = undefined;

  /** Retained for source compatibility; unused. */
  @property({ type: String })
  accessor label: string | undefined = undefined;

  /** Retained for source compatibility; unused. */
  @property({ type: Boolean })
  accessor inline = false;
}
