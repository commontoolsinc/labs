import { css, html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import {
  $conn,
  CellHandle,
  isCellHandle,
  RequestType,
} from "@commonfabric/runtime-client";
import type {
  JSONValue,
  PieceSourceAction,
  PieceSourceRevisionView,
  PieceSourceView,
} from "@commonfabric/runtime-client";
import {
  describeOrigin,
  formatTimestamp,
  shortIdentity,
} from "./origin-view.ts";

/** Which panel is showing, if any. */
export type Panel = "source" | "origin" | "data" | "actions";

/** One entry in the menu, and the panel it opens. */
interface MenuEntry {
  label: string;
  /** Stable hook for tests, exposed as the entry's `test-id`. */
  testId: string;
  panel: Panel;
}

const ENTRIES: readonly MenuEntry[] = [
  { label: "View source", testId: "piece-menu-source", panel: "source" },
  {
    label: "Origin and history",
    testId: "piece-menu-origin",
    panel: "origin",
  },
  { label: "Data", testId: "piece-menu-data", panel: "data" },
  { label: "Actions", testId: "piece-menu-actions", panel: "actions" },
];

const PANEL_TITLES: Record<Panel, string> = {
  source: "Source",
  origin: "Origin and history",
  data: "Data",
  actions: "Actions",
};

const DETACH_ENTRY = {
  label: "Stop following source",
  testId: "piece-menu-detach-source",
} as const;

/** The entries a piece menu shows, including detach for a followed piece. */
export function pieceMenuEntries(
  hasOrigin = false,
): readonly (MenuEntry | typeof DETACH_ENTRY)[] {
  return hasOrigin ? [...ENTRIES, DETACH_ENTRY] : ENTRIES;
}

/**
 * Whether a schema fragment declares a directly dispatchable stream. Only the
 * OUTERMOST `asCell` entry names the immediate kind: `["cell", "stream"]` is
 * a cell that contains a stream, and sending to that outer cell would be a
 * plain value write, not a dispatch.
 */
function schemaDeclaresStream(schema: unknown): boolean {
  const asCell = (schema as { asCell?: unknown } | null | undefined)?.asCell;
  if (!Array.isArray(asCell) || asCell.length === 0) return false;
  const outermost = asCell[0];
  return (typeof outermost === "string"
    ? outermost
    : (outermost as { kind?: string } | null)?.kind) === "stream";
}

/**
 * A handler stream whose own ref schema carries the `asCell: ["stream"]`
 * marker. This is not the usual live shape — a handler read through the
 * piece's schema arrives as a `CellHandle` carrying the handler's *event*
 * schema, and the stream declaration stays on the piece schema's property —
 * so callers also consult the parent schema (see `collectActions`).
 */
export function isStreamHandle(value: unknown): value is CellHandle {
  return isCellHandle(value) && schemaDeclaresStream(value.ref().schema);
}

/** The raw `{ $stream: true }` marker a schema-less read can surface. */
function isRawStreamMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { $stream?: unknown }).$stream === true;
}

/** Well-known view keys the Data panel omits: they hold VDOM, not data. */
const VIEW_KEYS = new Set(["$UI", "$TILE_UI", "$CHIP_UI"]);

/**
 * A read piece value is not plain JSON: links arrive hydrated as nested
 * `CellHandle`s, whose own toJSON would print verbose sigil links. Walk the
 * value into a display shape first — handles become `{"@cell": id}` stubs,
 * streams a `[stream]` tag — and cap the depth so a deep graph stays legible.
 */
export function formatPieceValue(
  value: unknown,
  streamKeys?: ReadonlySet<string>,
): string {
  const display = toDisplay(value, 0, streamKeys);
  if (display === undefined) return "undefined";
  try {
    return JSON.stringify(display, null, 2) ?? String(display);
  } catch (error) {
    return `<unrenderable: ${
      error instanceof Error ? error.message : String(error)
    }>`;
  }
}

function toDisplay(
  value: unknown,
  depth: number,
  streamKeys?: ReadonlySet<string>,
): unknown {
  if (isStreamHandle(value) || isRawStreamMarker(value)) return "[stream]";
  if (isCellHandle(value)) {
    const ref = value.ref();
    return ref.path.length > 0
      ? { "@cell": ref.id, path: ref.path.join("/") }
      : { "@cell": ref.id };
  }
  if (depth >= 8) return "…";
  if (Array.isArray(value)) {
    return value.map((item) => toDisplay(item, depth + 1));
  }
  // TODO(danfuzz): a `FabricSpecialObject` reaches this branch and is rebuilt
  // from enumerable properties it does not have, so a `FabricBytes` in an
  // argument or result renders as `{}`. The guard wants to be a shape test
  // (`isPlainObject`) with the special objects named by
  // `toCompactDebugString()` instead of descended.
  //
  // Note this is the second place such a value is lost, not the first: it
  // reaches the client through `postMessage`, and structured clone drops the
  // prototype and private fields on the way. Fixing this alone changes a `{}`
  // into a `{}` until the wire carries one.
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (depth === 0 && VIEW_KEYS.has(key)) continue;
      out[key] = depth === 0 && streamKeys?.has(key)
        ? "[stream]"
        : toDisplay(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** One dispatchable handler stream found on the piece. */
export interface PieceAction {
  name: string;
  /** Which side of the piece carries it. */
  source: "result" | "argument";
  handle: CellHandle;
  /**
   * The event schema the handler declares, when one is known: the schema a
   * stream handle read through the piece's schema carries is the handler's
   * payload shape.
   */
  eventSchema?: unknown;
}

/** The top-level property names of an event schema, as a payload hint. */
export function payloadHint(action: PieceAction): string | undefined {
  const properties =
    (action.eventSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
  if (!properties) return undefined;
  const names = Object.keys(properties);
  return names.length > 0 ? `{ ${names.join(", ")} }` : undefined;
}

/**
 * CFPieceMenu — the menu a right-click on a piece opens, with the panels for
 * what it can show and do about that piece: its authored source, the origin
 * and history it records, its live argument and result data, and the handler
 * streams an event can be dispatched to.
 *
 * @element cf-piece-menu
 *
 * Mounted on `document.body` by {@link openPieceMenu}, never inside the piece
 * it describes: a piece's own `overflow: hidden` would clip it, and the tile
 * variant's `transform: scale(0.5)` would both contain and shrink a
 * `position: fixed` overlay rendered in that subtree.
 *
 * A host that wants a different menu for a piece cancels the
 * `cf-piece-context-menu` announcement and shows its own; see
 * `docs/features/host-embedding.md`.
 */
export class CFPieceMenu extends BaseElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: block;
      font-family: var(--cf-theme-font-family, system-ui, sans-serif);
      color: var(--cf-theme-color-text, #111827);
    }

    :host([hidden]) {
      display: none;
    }

    .backdrop {
      position: absolute;
      inset: 0;
    }

    .backdrop.dimmed {
      background: rgba(0, 0, 0, 0.32);
    }

    .menu {
      position: absolute;
      min-width: 15rem;
      padding: 0.25rem;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 0 3px rgba(0, 0, 0, 0.16);
    }

    .menu-item {
      display: block;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.8125rem;
      color: inherit;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }

    .menu-item:hover,
    .menu-item:focus-visible {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .menu-title {
      padding: 0.375rem 0.75rem;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      max-width: 18rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      width: min(56rem, 92vw);
      max-height: 86vh;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
    }

    .panel-head h2 {
      margin: 0;
      font-size: 0.9375rem;
    }

    .panel-head .subject {
      flex: 1;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-close {
      padding: 0.25rem 0.5rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.875rem;
      color: inherit;
      cursor: pointer;
    }

    .panel-close:hover {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .panel-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 1rem 1.25rem;
    }

    .file-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.5rem 1.25rem 0;
    }

    .file-tab {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      cursor: pointer;
    }

    .file-tab.active {
      color: inherit;
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    pre.source {
      margin: 0;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
    }

    dl.facts {
      display: grid;
      grid-template-columns: minmax(8rem, max-content) 1fr;
      gap: 0.375rem 1rem;
      margin: 0;
      font-size: 0.8125rem;
    }

    dl.facts dt {
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    dl.facts dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
    }

    dl.facts dd.prose {
      font-family: inherit;
    }

    .note {
      margin: 1rem 0 0;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .error {
      margin: 0.75rem 0 0;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-error, #b91c1c);
      overflow-wrap: anywhere;
    }

    .status {
      margin: 0.75rem 0 0;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .section-title {
      margin: 0 0 0.5rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .section-title + p,
    pre.source + .section-title {
      margin-top: 1rem;
    }

    .payload-label {
      display: block;
      margin-bottom: 0.75rem;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .payload {
      display: block;
      width: 100%;
      min-height: 4rem;
      margin-top: 0.25rem;
      padding: 0.5rem;
      box-sizing: border-box;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      color: inherit;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 12px;
      resize: vertical;
    }

    .actions-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .action-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
      border-radius: 6px;
    }

    .action-name {
      flex: 1;
      min-width: 6rem;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 0.8125rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-hint {
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 18rem;
    }

    .action-source {
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .action-send,
    .refresh {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.75rem;
      color: inherit;
      cursor: pointer;
    }

    .action-send:hover,
    .refresh:hover {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .history {
      margin-top: 1.25rem;
    }

    .history h3 {
      margin: 0 0 0.625rem;
      font-size: 0.8125rem;
    }

    .revision {
      display: grid;
      gap: 0.375rem;
      padding: 0.75rem 0;
      border-top: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
      font-size: 0.75rem;
    }

    .revision-head,
    .revision-actions,
    .warning-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .revision-head {
      justify-content: space-between;
    }

    .revision-details {
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow-wrap: anywhere;
    }

    .revision button,
    .source-action,
    .warning button {
      padding: 0.3rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: var(--cf-theme-color-surface, #ffffff);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .revision button:disabled,
    .source-action:disabled,
    .warning button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .warning {
      margin: 1rem 0;
      padding: 0.75rem;
      border: 1px solid var(--cf-theme-color-error, #b91c1c);
      border-radius: 8px;
      font-size: 0.75rem;
    }

    .warning p {
      margin: 0 0 0.625rem;
      white-space: pre-wrap;
    }
  `;

  /** The piece the menu addresses. */
  declare cell?: CellHandle;

  /** Where the click landed, in client coordinates. */
  declare x: number;
  declare y: number;

  static override properties = {
    cell: { attribute: false },
    x: { attribute: false },
    y: { attribute: false },
  };

  @state()
  private accessor panel: Panel | undefined = undefined;

  @state()
  private accessor selectedFile = 0;

  @state()
  private accessor source: PieceSourceView | undefined = undefined;

  @state()
  private accessor readError: string | undefined = undefined;

  @state()
  private accessor argumentValue: unknown = undefined;

  @state()
  private accessor argumentLoaded = false;

  @state()
  private accessor resultValue: unknown = undefined;

  @state()
  private accessor dataError: string | undefined = undefined;

  @state()
  private accessor payloadText = "";

  @state()
  private accessor dispatchNote:
    | { kind: "ok" | "error"; text: string }
    | undefined = undefined;

  @state()
  private accessor sourceActionPending = false;

  @state()
  private accessor sourceActionError: string | undefined = undefined;

  @state()
  private accessor sourceExecutionWarning: string | undefined = undefined;

  @state()
  private accessor compatibilityWarning:
    | {
      action: PieceSourceAction;
      message: string;
      confirmationToken: string;
    }
    | undefined = undefined;

  /** Identifies the read a late response belongs to, so a stale one is dropped. */
  private readToken = 0;
  private sourceRead: Promise<void> | undefined;

  /** Set once a data/actions panel has started its piece-state read. */
  #dataRequested = false;

  /**
   * The generation of the current piece-state read. Every reset — reopening,
   * closing, disconnecting, refreshing — advances it, and every step of an
   * in-flight read checks it, so a read that outlives its generation can
   * neither install a subscription nor write stale state.
   */
  #dataGeneration = 0;

  /** The schema-bearing handle the page read resolved, for addressing streams. */
  #pieceCell: CellHandle | undefined;

  /** The schema-bearing handle of the piece's argument cell, when resolved. */
  #argumentCell: CellHandle | undefined;

  /** Cancels the live result subscription. */
  #cancelResult: (() => void) | undefined;

  /** Cancels the live argument subscription. */
  #cancelArgument: (() => void) | undefined;

  /** True while a dispatch is in flight, so a rapid double-click sends once. */
  #dispatching = false;

  constructor() {
    super();
    this.x = 0;
    this.y = 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("keydown", this.#onKeyDown);
  }

  override disconnectedCallback() {
    globalThis.removeEventListener("keydown", this.#onKeyDown);
    this.#resetPieceState();
    super.disconnectedCallback();
  }

  /** Show the menu for `cell` at a click position. */
  open({ cell, x, y }: { cell: CellHandle; x: number; y: number }): void {
    this.cell = cell;
    this.x = x;
    this.y = y;
    this.panel = undefined;
    this.selectedFile = 0;
    this.source = undefined;
    this.readError = undefined;
    this.#resetPieceState();
    this.payloadText = "";
    this.sourceRead = undefined;
    this.sourceActionPending = false;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    this.readToken++;
    this.hidden = false;
    void this.#readSource(cell);
  }

  /** Hide the menu and forget the piece it was describing. */
  close(): void {
    this.hidden = true;
    this.panel = undefined;
    this.cell = undefined;
    this.source = undefined;
    this.#resetPieceState();
    this.sourceRead = undefined;
    this.sourceActionPending = false;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    this.readToken++;
  }

  /** Drop everything the data/actions panels read, and their subscriptions. */
  #resetPieceState(): void {
    // Invalidate first: an in-flight read must see the new generation before
    // any of its remaining steps run, or a late completion could subscribe
    // after this cleanup and leak.
    this.#dataGeneration++;
    this.#cancelResult?.();
    this.#cancelResult = undefined;
    this.#cancelArgument?.();
    this.#cancelArgument = undefined;
    this.#pieceCell = undefined;
    this.#argumentCell = undefined;
    this.#dataRequested = false;
    this.argumentValue = undefined;
    this.argumentLoaded = false;
    this.resultValue = undefined;
    this.dataError = undefined;
    this.dispatchNote = undefined;
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (this.hidden || e.key !== "Escape") return;
    e.preventDefault();
    // Escape steps back from a panel to the menu, then closes.
    if (this.panel) this.panel = undefined;
    else this.close();
  };

  /** Show the source file at `index`, as choosing its tab does. */
  selectFile(index: number): void {
    this.selectedFile = index;
  }

  /**
   * A right-click on the backdrop dismisses the menu rather than opening a
   * second one behind it.
   */
  private _onBackdropContextMenu = (e: Event) => {
    e.preventDefault();
    this.close();
  };

  /**
   * Show one of the panels, as choosing its entry does. The source panels
   * read the piece's source state the first time either is opened for that
   * piece; the data and actions panels read its argument and result the
   * first time either of those is.
   */
  async showPanel(panel: Panel) {
    this.panel = panel;
    this.selectedFile = 0;
    const cell = this.cell;
    if (!cell) return;
    if (panel === "data" || panel === "actions") {
      if (this.#dataRequested) return;
      this.#dataRequested = true;
      await this.#readPieceState(cell);
      return;
    }
    if (this.source !== undefined) return;
    await this.#readSource(cell);
  }

  #readSource(cell: CellHandle): Promise<void> {
    this.sourceRead ??= this.#performSourceRead(cell);
    return this.sourceRead;
  }

  async #performSourceRead(cell: CellHandle): Promise<void> {
    const token = this.readToken;
    try {
      const source = await cell.runtime().getPieceSource(
        cell.id(),
        cell.space(),
      );
      if (token !== this.readToken) return;
      this.source = source;
    } catch (error) {
      if (token !== this.readToken) return;
      // A disposal race (logout, runtime swap) cancels the read; that is
      // cancellation, not a failure to report.
      if (cell.runtime().signal.aborted) return;
      this.readError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Read the piece's argument and result. The menu's own cell addresses the
   * piece but carries no result schema, and stream fields only keep their
   * `asCell` tags under a schema'd read, so the page read resolves one —
   * running the piece if it was not already.
   */
  async #readPieceState(cell: CellHandle): Promise<void> {
    const generation = this.#dataGeneration;
    const fresh = () => generation === this.#dataGeneration;
    try {
      const rt = cell.runtime();
      const page = await rt.getPage(cell.id(), cell.space(), true);
      if (!fresh()) return;
      const pieceCell = (page?.cell() as CellHandle | undefined) ?? cell;
      this.#pieceCell = pieceCell;
      this.#cancelResult = pieceCell.subscribe((value) => {
        if (!fresh()) return;
        this.resultValue = value;
      });
      const response = await rt[$conn]().request<RequestType.CellGet>({
        type: RequestType.CellGet,
        cell: pieceCell.ref(),
        meta: "argument",
        includeRef: true,
      });
      if (!fresh()) return;
      if (response.cell) {
        // The argument's own schema-bearing ref: its schema carries the
        // stream declarations for argument-side handlers, and the handle
        // gives the panel a live view instead of a one-shot snapshot.
        const argumentCell = new CellHandle(
          rt,
          response.cell,
          CellHandle.deserialize(
            new CellHandle(rt, response.cell),
            response.value,
          ),
        );
        this.#argumentCell = argumentCell;
        this.#cancelArgument = argumentCell.subscribe((value) => {
          if (!fresh()) return;
          this.argumentValue = value;
        });
      } else {
        this.argumentValue = CellHandle.deserialize(pieceCell, response.value);
      }
      this.argumentLoaded = true;
    } catch (error) {
      if (!fresh()) return;
      if (cell.runtime().signal.aborted) return;
      this.dataError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Re-read the piece's argument and result, as the Refresh control does.
   * Also the retry path for a failed read: the reset advances the read
   * generation, so a still-in-flight earlier read cannot install anything.
   */
  refreshData(): void {
    const cell = this.cell;
    if (!cell) return;
    const dispatchNote = this.dispatchNote;
    this.#resetPieceState();
    // A refresh replaces the read, not the conversation: keep the last
    // dispatch outcome visible.
    this.dispatchNote = dispatchNote;
    this.#dataRequested = true;
    void this.#readPieceState(cell);
  }

  /** A schema's per-property fragments. */
  #schemaProperties(of: CellHandle | undefined): Record<string, unknown> {
    const schema = of?.ref().schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    return schema?.properties ?? {};
  }

  /** The result keys the piece schema declares as streams. */
  #declaredStreamKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (
      const [name, fragment] of Object.entries(
        this.#schemaProperties(this.#pieceCell),
      )
    ) {
      if (schemaDeclaresStream(fragment)) keys.add(name);
    }
    return keys;
  }

  /**
   * The handler streams the piece's argument and result carry at their top
   * level, deduplicated when the same stream is reachable from both sides.
   *
   * A handler read through a schema'd read arrives as a `CellHandle` carrying
   * the handler's event schema; the `asCell: ["stream"]` declaration stays on
   * the PARENT schema's property, so each side's parent schema is the primary
   * signal (piece schema for the result, argument schema for the argument).
   * The handle's own schema tag covers a value that arrived stream-tagged.
   * There is deliberately no guess for an untagged, undeclared handle:
   * dispatching to a non-stream cell would silently overwrite its value.
   */
  collectActions(): PieceAction[] {
    const actions: PieceAction[] = [];
    const seen = new Set<string>();
    const parents = {
      result: this.#pieceCell,
      argument: this.#argumentCell,
    };
    const scan = (value: unknown, source: "result" | "argument") => {
      if (
        typeof value !== "object" || value === null || Array.isArray(value)
      ) return;
      const declared = this.#schemaProperties(parents[source]);
      for (const [name, item] of Object.entries(value)) {
        const declaredStream = schemaDeclaresStream(declared[name]);
        let handle: CellHandle | undefined;
        if (isCellHandle(item)) {
          if (!declaredStream && !isStreamHandle(item)) continue;
          handle = item;
        } else if (declaredStream && parents[source]) {
          // The value did not arrive as a handle (e.g. a raw `{$stream:true}`
          // marker from a schema-less read), but the parent schema declares
          // the stream — address it through the parent, which is the trusted
          // signal here; a bare marker alone is never dispatchable.
          handle = (parents[source]!.asSchema(
            {
              type: "object",
              properties: { [name]: { asCell: ["stream"] } },
              required: [name],
            } as unknown as Parameters<CellHandle["asSchema"]>[0],
          ) as CellHandle<Record<string, unknown>>).key(name) as CellHandle;
        } else {
          continue;
        }
        // Identity is structural, minus the schema: the same stream seen
        // through two reads carries two different schema views.
        const ref = handle.ref();
        const key = JSON.stringify({
          space: ref.space,
          scope: ref.scope,
          id: ref.id,
          path: ref.path,
        });
        if (seen.has(key)) continue;
        seen.add(key);
        const eventSchema = schemaDeclaresStream(ref.schema)
          ? undefined
          : ref.schema;
        actions.push({ name, source, handle, eventSchema });
      }
    };
    scan(this.resultValue, "result");
    scan(this.argumentValue, "argument");
    return actions;
  }

  /**
   * Dispatch an event to one of the piece's handler streams, with the panel's
   * JSON payload if one was entered. Goes through the raw request rather than
   * `CellHandle.send()`, which logs and swallows failures — but note the
   * limit: the worker commits the event asynchronously after acknowledging
   * the request, so acceptance here means "accepted for delivery". A refusal
   * during the later commit is not reported back.
   */
  async dispatchAction(action: PieceAction): Promise<void> {
    const cell = this.cell;
    if (!cell || this.#dispatching) return;
    this.dispatchNote = undefined;
    // What `JSON.parse()` yields, which is what a cell's value may be minus
    // the handles this menu never puts in one.
    let payload: JSONValue = {};
    const text = this.payloadText.trim();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        this.dispatchNote = {
          kind: "error",
          text: `The payload is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
        return;
      }
    }
    const generation = this.#dataGeneration;
    this.#dispatching = true;
    try {
      await cell.runtime()[$conn]().request<RequestType.CellSend>({
        type: RequestType.CellSend,
        cell: action.handle.ref(),
        event: CellHandle.serialize(payload),
      });
      if (generation !== this.#dataGeneration) return;
      this.dispatchNote = {
        kind: "ok",
        text: `Event accepted for ${action.name}.`,
      };
    } catch (error) {
      if (generation !== this.#dataGeneration) return;
      if (cell.runtime().signal.aborted) return;
      this.dispatchNote = {
        kind: "error",
        text: `Dispatch to ${action.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      this.#dispatching = false;
    }
  }

  /** Apply one source-history action, optionally accepting incompatibility. */
  async changeSource(
    action: PieceSourceAction,
    confirmationToken?: string,
  ): Promise<void> {
    const cell = this.cell;
    if (!cell || this.sourceActionPending) return;
    const token = this.readToken;
    this.sourceActionPending = true;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    try {
      const response = await cell.runtime().updatePieceSource(
        cell.id(),
        cell.space(),
        action,
        confirmationToken === undefined ? {} : { confirmationToken },
      );
      if (token !== this.readToken) return;
      this.source = response.source;
      if (response.compatibilityWarning !== undefined) {
        if (response.confirmationToken === undefined) {
          throw new Error(
            "the runtime did not provide a compatibility confirmation",
          );
        }
        this.compatibilityWarning = {
          action,
          message: response.compatibilityWarning,
          confirmationToken: response.confirmationToken,
        };
      } else {
        this.compatibilityWarning = undefined;
        this.sourceExecutionWarning = response.executionWarning;
        this.panel = "origin";
      }
    } catch (error) {
      if (token !== this.readToken || cell.runtime().signal.aborted) return;
      this.sourceActionError = error instanceof Error
        ? error.message
        : String(error);
      this.panel = "origin";
    } finally {
      if (token === this.readToken) this.sourceActionPending = false;
    }
  }

  protected override render() {
    if (this.hidden || !this.cell) return nothing;
    return this.panel ? this.#renderPanel(this.panel) : this.#renderMenu();
  }

  #renderMenu(): TemplateResult {
    // Keep the menu inside the viewport: a click near the right or bottom edge
    // clamps it back into view.
    const entries = pieceMenuEntries(this.source?.origin !== undefined);
    const width = 240;
    const height = 40 + entries.length * 34;
    const left = Math.max(
      4,
      Math.min(this.x, globalThis.innerWidth - width - 4),
    );
    const top = Math.max(
      4,
      Math.min(this.y, globalThis.innerHeight - height - 4),
    );
    return html`
      <div
        class="backdrop"
        @click="${() => this.close()}"
        @contextmenu="${this._onBackdropContextMenu}"
      ></div>
      <div class="menu" role="menu" style="left: ${left}px; top: ${top}px">
        <div class="menu-title">Piece ${this.cell!.id()}</div>
        ${entries.map((entry) =>
          html`
            <button
              class="menu-item"
              role="menuitem"
              test-id="${entry.testId}"
              ?disabled="${this.sourceActionPending}"
              @click="${() =>
                "panel" in entry
                  ? this.showPanel(entry.panel)
                  : this.changeSource({ kind: "detach" })}"
            >
              ${entry.label}
            </button>
          `
        )}
      </div>
    `;
  }

  #renderPanel(panel: Panel): TemplateResult {
    const title = PANEL_TITLES[panel];
    const subject = this.source?.name ?? this.cell?.id() ?? "";
    return html`
      <div class="backdrop dimmed" @click="${() => this.close()}"></div>
      <div
        class="panel"
        role="dialog"
        aria-label="${title}"
        test-id="piece-panel-${panel}"
      >
        <div class="panel-head">
          <h2>${title}</h2>
          <span class="subject">${subject}</span>
          <button class="panel-close" @click="${() => this.close()}">
            Close
          </button>
        </div>
        ${panel === "source" ? this.#renderSourceTabs() : nothing}
        <div class="panel-body">
          ${panel === "data"
            ? this.#renderData()
            : panel === "actions"
            ? this.#renderActions()
            : this.readError
            ? html`
              <p class="error">
                Could not read this piece's source: ${this.readError}
              </p>
            `
            : this.source === undefined
            ? html`
              <p>Reading source…</p>
            `
            : panel === "source"
            ? this.#renderSource(this.source)
            : this.#renderOrigin(this.source)}
        </div>
      </div>
    `;
  }

  /** A read failure with the retry the failure would otherwise block. */
  #renderDataError(what: string): TemplateResult {
    return html`
      <p class="error">
        Could not read this piece's ${what}: ${this.dataError}
        <button class="refresh" @click="${() => this.refreshData()}">
          Retry
        </button>
      </p>
    `;
  }

  #renderData(): TemplateResult {
    if (this.dataError) return this.#renderDataError("data");
    return html`
      <h3 class="section-title">Argument</h3>
      ${this.argumentLoaded
        ? html`
          <pre class="source">${formatPieceValue(this.argumentValue)}</pre>
        `
        : html`
          <p>Reading argument…</p>
        `}
      <h3 class="section-title">Result</h3>
      ${this.resultValue === undefined
        ? html`
          <p>Waiting for a value…</p>
        `
        : html`
          <pre class="source">${formatPieceValue(
            this.resultValue,
            this.#declaredStreamKeys(),
          )}</pre>
        `}
      <p class="note">
        Values stay live while the menu is open.
        <button class="refresh" @click="${() => this.refreshData()}">
          Refresh
        </button>
      </p>
    `;
  }

  #renderActions(): TemplateResult {
    if (this.dataError) return this.#renderDataError("handlers");
    if (!this.argumentLoaded && this.resultValue === undefined) {
      return html`
        <p>Reading handlers…</p>
      `;
    }
    const actions = this.collectActions();
    if (actions.length === 0) {
      return html`
        <p>This piece exposes no handler streams.</p>
        <p class="note">
          Handlers appear here when the piece's argument or result carries stream
          fields.
        </p>
      `;
    }
    return html`
      <label class="payload-label">
        Optional JSON event payload
        <textarea
          class="payload"
          placeholder="{}"
          .value="${this.payloadText}"
          @input="${(e: Event) => {
            this.payloadText = (e.target as HTMLTextAreaElement).value;
          }}"
        ></textarea>
      </label>
      <div class="actions-list">
        ${actions.map((action) =>
          html`
            <div class="action-row">
              <span class="action-name">${action.name}</span>
              ${payloadHint(action)
                ? html`
                  <span class="action-hint">${payloadHint(action)}</span>
                `
                : nothing}
              <span class="action-source">${action.source}</span>
              <button
                class="action-send"
                test-id="piece-action-${action.name}"
                @click="${() => this.dispatchAction(action)}"
              >
                Send
              </button>
            </div>
          `
        )}
      </div>
      ${this.dispatchNote
        ? html`
          <p class="${this.dispatchNote.kind === "error" ? "error" : "status"}">
            ${this.dispatchNote.text}
          </p>
        `
        : nothing}
      <p class="note">
        "Accepted" means the runtime accepted the event for delivery; the commit
        happens asynchronously, so a later refusal is not reported here. Events sent
        here are also not renderer-trusted: a handler gated on UI provenance will
        refuse them.
      </p>
    `;
  }

  #renderSourceTabs() {
    const files = this.source?.files ?? [];
    if (files.length < 2) return nothing;
    return html`
      <div class="file-tabs">
        ${files.map((file, index) =>
          html`
            <button
              class="file-tab ${index === this.selectedFile ? "active" : ""}"
              @click="${() => this.selectFile(index)}"
            >
              ${file.name}
            </button>
          `
        )}
      </div>
    `;
  }

  #renderSource(source: PieceSourceView): TemplateResult {
    if (source.files.length === 0) {
      return html`
        <p>
          This piece's source is not available in its space. Its pattern is ${source
              .pattern
            ? html`
              <code>${source.pattern.identity}</code>
            `
            : "not recorded"}.
        </p>
      `;
    }
    const file =
      source.files[Math.min(this.selectedFile, source.files.length - 1)];
    return html`
      <pre class="source">${file.contents}</pre>
    `;
  }

  #renderOrigin(source: PieceSourceView): TemplateResult {
    const origin = describeOrigin(source.origin);
    return html`
      <dl class="facts">
        <dt>Origin</dt>
        <dd class="prose">
          ${origin.label}${source.origin
            ? html`
              — <code>${source.origin.url}</code>
            `
            : nothing}
          <div class="note">${origin.detail}</div>
        </dd>
        ${source.origin?.recorded
          ? html`
            <dt>Recorded as</dt>
            <dd>${source.origin.recorded}</dd>
          `
          : nothing} ${source.pattern
          ? html`
            <dt>Pattern</dt>
            <dd title="${source.pattern.identity}">
              ${shortIdentity(source.pattern.identity)} · ${source.pattern
                .symbol}
            </dd>
          `
          : nothing} ${source.setupPattern &&
            (source.setupPattern.identity !== source.pattern?.identity ||
              source.setupPattern.symbol !== source.pattern?.symbol)
          ? html`
            <dt>Setup applied for</dt>
            <dd title="${source.setupPattern.identity}">
              ${shortIdentity(source.setupPattern.identity)} · ${source
                .setupPattern.symbol}
            </dd>
          `
          : nothing} ${source.displacedPattern
          ? html`
            <dt>Previously ran</dt>
            <dd title="${source.displacedPattern.identity}">
              ${shortIdentity(source.displacedPattern.identity)} · ${source
                .displacedPattern.symbol}${source.displacedPattern.displacedAt
                ? ` · replaced ${
                  formatTimestamp(source.displacedPattern.displacedAt)
                }`
                : ""}
            </dd>
          `
          : nothing} ${source.repository
          ? html`
            <dt>Repository</dt>
            <dd>${source.repository}</dd>
          `
          : nothing} ${source.entry
          ? html`
            <dt>Entry file</dt>
            <dd>${source.entry}</dd>
          `
          : nothing}
        <dt>Files retained</dt>
        <dd>${source.files.length}</dd>
        <dt>Piece</dt>
        <dd>${source.pieceId}</dd>
        <dt>Space</dt>
        <dd>${source.space}</dd>
      </dl>
      ${this.sourceActionError
        ? html`
          <p class="error">
            Could not change this piece's source: ${this.sourceActionError}
          </p>
        `
        : nothing} ${this.sourceExecutionWarning
        ? html`
          <p class="error">
            The source change was saved, but a later refresh failed: ${this
              .sourceExecutionWarning}
          </p>
        `
        : nothing} ${this.#renderCompatibilityWarning()} ${source.origin
        ? html`
          <p>
            <button
              class="source-action"
              test-id="piece-origin-detach-source"
              ?disabled="${this.sourceActionPending}"
              @click="${() => this.changeSource({ kind: "detach" })}"
            >
              Stop following source
            </button>
          </p>
        `
        : nothing} ${this.#renderHistory(source)}
    `;
  }

  #renderCompatibilityWarning() {
    const warning = this.compatibilityWarning;
    if (warning === undefined) return nothing;
    return html`
      <div class="warning" role="alert" test-id="piece-source-warning">
        <p>
          This source version changes the piece's data contract: ${warning
            .message}
        </p>
        <div class="warning-actions">
          <button
            test-id="piece-source-warning-confirm"
            ?disabled="${this.sourceActionPending}"
            @click="${() =>
              this.changeSource(
                warning.action,
                warning.confirmationToken,
              )}"
          >
            Use it anyway
          </button>
          <button
            test-id="piece-source-warning-cancel"
            ?disabled="${this.sourceActionPending}"
            @click="${() => {
              this.compatibilityWarning = undefined;
            }}"
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  #renderHistory(source: PieceSourceView) {
    if (source.history.length === 0) {
      return html`
        <section class="history">
          <h3>Source history</h3>
          <p class="note">
            No source changes have been recorded yet. The first change will retain this
            current version as the baseline.
          </p>
        </section>
      `;
    }
    return html`
      <section class="history">
        <h3>Source history</h3>
        ${[...source.history].reverse().map((revision) =>
          this.#renderRevision(source, revision)
        )}
      </section>
    `;
  }

  #renderRevision(
    source: PieceSourceView,
    revision: PieceSourceRevisionView,
  ) {
    const current = revision.revisionId === source.currentRevisionId;
    const origin = describeOrigin(revision.origin);
    const alreadyFollowing = revision.origin !== undefined &&
      source.origin?.url === revision.origin.url;
    return html`
      <article class="revision" test-id="piece-source-revision">
        <div class="revision-head">
          <strong>
            ${sourceOperationLabel(revision.operation)}${current
              ? " · Current"
              : ""}
          </strong>
          <span>${formatTimestamp(revision.timestamp)}</span>
        </div>
        <div class="revision-details">
          Pattern ${shortIdentity(revision.pattern.identity)} · ${revision
            .pattern.symbol}
        </div>
        <div class="revision-details">
          ${origin.label}${revision.origin
            ? html`
              — <code>${revision.origin.url}</code>
            `
            : nothing}
        </div>
        ${current ? nothing : html`
          <div class="revision-actions">
            <button
              test-id="piece-source-restore"
              ?disabled="${this.sourceActionPending}"
              @click="${() =>
                this.changeSource({
                  kind: "restore",
                  revisionId: revision.revisionId,
                })}"
            >
              Use this version
            </button>
            ${revision.origin !== undefined && !alreadyFollowing
              ? html`
                <button
                  test-id="piece-source-follow"
                  ?disabled="${this.sourceActionPending}"
                  @click="${() =>
                    this.changeSource({
                      kind: "follow",
                      revisionId: revision.revisionId,
                    })}"
                >
                  ${revision.origin.kind === "fabric-pattern"
                    ? "Use this pinned source again"
                    : "Follow this source again"}
                </button>
              `
              : nothing}
          </div>
        `}
      </article>
    `;
  }
}

function sourceOperationLabel(
  operation: PieceSourceRevisionView["operation"],
): string {
  switch (operation) {
    case "baseline":
      return "Baseline";
    case "create":
      return "Created from source";
    case "edit":
      return "Direct source edit";
    case "origin-update":
      return "Source update";
    case "detach":
      return "Stopped following source";
    case "revert":
      return "Restored source version";
    case "follow":
      return "Followed source";
    case "repoint":
      return "Followed earlier source";
  }
}

/**
 * The theme tokens the menu reads. Mounting outside `cf-theme`'s subtree is what
 * keeps the menu clear of a piece's clipping and scaling, and it also puts it
 * out of reach of the inherited theme variables, so these are copied across from
 * the element that opened it.
 */
const THEME_VARIABLES = [
  "--cf-theme-font-family",
  "--cf-theme-font-mono",
  "--cf-theme-color-text",
  "--cf-theme-color-text-muted",
  "--cf-theme-color-surface",
  "--cf-theme-color-surface-hover",
  "--cf-theme-color-border",
  "--cf-theme-color-error",
];

/** Copy the menu's theme tokens from `from`, resolved, onto `to`. */
function copyThemeVariables(from: Element, to: HTMLElement): void {
  const computed = globalThis.getComputedStyle(from);
  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) to.style.setProperty(name, value);
    else to.style.removeProperty(name);
  }
}

/**
 * The one menu element, mounted on `document.body`. A single shared instance
 * means a right-click while a menu is open replaces it rather than stacking
 * another overlay, and the element outlives the `cf-render` that opened it (a
 * piece can re-render, or stop, while its menu is up).
 */
let shared: CFPieceMenu | undefined;

/** Show the piece menu for `cell` at a click position. */
export function openPieceMenu(
  { cell, x, y, themeFrom }: {
    cell: CellHandle;
    x: number;
    y: number;
    /** The element the click came from, whose theme the menu adopts. */
    themeFrom?: Element;
  },
): CFPieceMenu {
  if (!shared || !shared.isConnected) {
    shared = globalThis.document.createElement("cf-piece-menu") as CFPieceMenu;
    globalThis.document.body.appendChild(shared);
  }
  if (themeFrom) copyThemeVariables(themeFrom, shared);
  shared.open({ cell, x, y });
  return shared;
}
