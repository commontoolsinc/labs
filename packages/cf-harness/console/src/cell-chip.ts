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

/** Distinguishes one chip's card from another's, for `aria-describedby`. */
let cardSequence = 0;

export class ConsoleCell extends LitElement {
  static override properties = {
    cell: { attribute: false },
    origin: { attribute: false },
  };

  declare cell: ConsoleCellFacts | undefined;
  /** Whether to offer the jump back to where the cell was produced. */
  declare origin: boolean;

  /**
   * The card's id, so the chip can name it as its description rather than
   * flattening the whole card into one label — a reader gets the handle, the
   * address and the atoms as the structure they are.
   */
  readonly #cardId = `cell-card-${++cardSequence}`;

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
    // Width first, and before measuring. A maximum alone does not hold the
    // card inside a narrow window: CSS resolves a minimum over a maximum, so
    // the stylesheet's minimum has to come down with it.
    const available = Math.max(0, globalThis.innerWidth - 16);
    card.style.minWidth = "";
    const floor = parseFloat(globalThis.getComputedStyle(card).minWidth) || 0;
    card.style.maxWidth = `${available}px`;
    if (floor > available) {
      card.style.minWidth = `${available}px`;
    }
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

  /**
   * Follows the chip while the card is up. The card is fixed-position so a
   * scrolling column cannot clip it, which also means a column scrolling under
   * it leaves it behind — so it is placed again on any scroll, captured
   * because the column scrolls rather than the window.
   */
  readonly #follow = (): void => {
    if (this.#showing) {
      this.#place();
    }
  };

  #showing = false;
  /**
   * Hover and focus each keep the card up on their own — `:hover, :focus-within`
   * is an or — so tracking stops only when neither is left. Closing on
   * `mouseleave` alone strands a card the keyboard is still holding open.
   */
  #hovered = false;
  #focused = false;

  #open(by: "hover" | "focus"): void {
    if (by === "hover") {
      this.#hovered = true;
    } else {
      this.#focused = true;
    }
    if (!this.#showing) {
      this.#showing = true;
      globalThis.addEventListener("scroll", this.#follow, true);
      globalThis.addEventListener("resize", this.#follow);
    }
    this.#place();
  }

  #close(by?: "hover" | "focus"): void {
    if (by === "hover") {
      this.#hovered = false;
    } else if (by === "focus") {
      this.#focused = false;
    } else {
      this.#hovered = false;
      this.#focused = false;
    }
    if (this.#hovered || this.#focused) {
      return;
    }
    this.#showing = false;
    globalThis.removeEventListener("scroll", this.#follow, true);
    globalThis.removeEventListener("resize", this.#follow);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#close();
  }

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
        aria-describedby=${this.#cardId}
        @mouseenter=${() => this.#open("hover")}
        @mouseleave=${() => this.#close("hover")}
        @focusin=${() => this.#open("focus")}
        @focusout=${() => this.#close("focus")}
      >
        <span class="cell-dot"></span>
        <span class="cell-name">${cellName(cell)}</span>
        ${atoms.length === 0
          ? nothing
          : html`<span class="cell-atoms">${atoms.length}</span>`}
        <span class="cell-card" id=${this.#cardId} role="tooltip">
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
