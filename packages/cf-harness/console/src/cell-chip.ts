/**
 * The one way a cell is drawn.
 *
 * A cell shows up in an argument, in a flow node, in the handles a step holds —
 * and it has to look the same in each, or a reader cannot tell that two of them
 * are the same thing. So there is one element for it: the name it carries, and
 * on hover the handle, the address, the shape and the CFC atoms riding on it.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";

/** What a chip needs to know to draw a cell. */
export interface ConsoleCellFacts {
  token?: string;
  ref?: string;
  slug?: string;
  producedByStep?: number;
  confidentiality?: readonly string[];
  schema?: unknown;
}

/**
 * What to call a cell. The name a person gave it wins, then the handle the
 * model held, then the address — most human-legible first, because that is
 * what makes two sightings of one cell recognisable as one cell.
 */
export const cellName = (cell: ConsoleCellFacts): string =>
  cell.slug ?? cell.token ?? cell.ref ?? "cell";

const schemaSummary = (schema: unknown): string | undefined => {
  const record = typeof schema === "object" && schema !== null
    ? schema as { type?: unknown; properties?: Record<string, unknown> }
    : undefined;
  if (record?.properties !== undefined) {
    const keys = Object.keys(record.properties);
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
  }
  return typeof record?.type === "string" ? record.type : undefined;
};

export class ConsoleCell extends LitElement {
  static override properties = {
    cell: { attribute: false },
    origin: { attribute: false },
  };

  declare cell: ConsoleCellFacts | undefined;
  /** Whether to offer the jump back to where the cell was produced. */
  declare origin: boolean;

  constructor() {
    super();
    this.origin = true;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /**
   * Places the card against the chip. It is fixed-position — an absolutely
   * placed one is clipped by whichever column is scrolling — so its
   * coordinates are the chip's own, in viewport space, nudged back inside the
   * window when the chip sits near an edge.
   */
  readonly #place = (): void => {
    const chip = this.querySelector(".cell") as HTMLElement | null;
    const card = this.querySelector(".cell-card") as HTMLElement | null;
    if (chip === null || card === null) {
      return;
    }
    const at = chip.getBoundingClientRect();
    card.style.left = "0";
    card.style.top = "0";
    const size = card.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(at.left, globalThis.innerWidth - size.width - 8),
    );
    const below = at.bottom + 6;
    const top = below + size.height > globalThis.innerHeight
      ? Math.max(8, at.top - size.height - 6)
      : below;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };

  protected override render(): TemplateResult | typeof nothing {
    const cell = this.cell;
    if (cell === undefined) {
      return nothing;
    }
    const shape = schemaSummary(cell.schema);
    const atoms = cell.confidentiality ?? [];
    return html`
      <span
        class="cell ${atoms.length > 0 ? "labelled" : ""}"
        tabindex="0"
        role="button"
        aria-label="cell ${cellName(cell)}"
        @mouseenter=${this.#place}
        @focusin=${this.#place}
      >
        <span class="cell-dot"></span>
        <span class="cell-name">${cellName(cell)}</span>
        ${atoms.length === 0
          ? nothing
          : html`<span class="cell-atoms">${atoms.length}</span>`}
        <span class="cell-card">
          ${cell.slug === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">name</span>
              <span>${cell.slug}</span>
            </span>
          `}
          ${cell.token === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">handle</span>
              <span class="cell-mono">${cell.token}</span>
            </span>
          `}
          ${cell.ref === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">address</span>
              <span class="cell-mono cell-wrap">${cell.ref}</span>
            </span>
          `}
          ${shape === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">shape</span>
              <span class="cell-mono">${shape}</span>
            </span>
          `}
          <span class="cell-row">
            <span class="cell-label">cfc</span>
            <span>
              ${atoms.length === 0
                ? html`<span class="cell-none">no labels recorded</span>`
                : atoms.map((name) =>
                  html`<span class="atom conf">${name}</span>`
                )}
            </span>
          </span>
          ${cell.producedByStep === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">from</span>
              <span>step ${cell.producedByStep}</span>
            </span>
          `}
        </span>
      </span>
    `;
  }
}

customElements.define("console-cell", ConsoleCell);
