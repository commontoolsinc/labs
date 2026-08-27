/**
 * The kickoff page. Type a task, watch the harness work, open what it built,
 * and read what any run did step by step.
 *
 * There is one reading of a run rather than two. A turn produces a run, and a
 * run's artifacts are the record of it — so the timeline is what the page
 * shows whether the turn finished an hour ago or is still going, and the live
 * event stream drives the status line and the re-reads rather than a feed of
 * its own.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import {
  cancelTurn,
  type HarnessChatEventEnvelope,
  type KickoffRunSummary,
  listRuns,
  startTask,
} from "./api.ts";
import "./run-view.ts";

/** The address a run named, raised above the timeline once it exists. */
interface Piece {
  slug?: string;
  url: string;
}

/** A run and the `delegate_task` children it started. */
interface RunNode {
  run: KickoffRunSummary;
  children: RunNode[];
}

/**
 * The run list as a tree. A subagent run names its parent, so a child sits
 * under the run that delegated to it rather than beside it at the top level,
 * where it would read as work someone asked for directly.
 */
export const runTree = (
  runs: readonly KickoffRunSummary[],
): readonly RunNode[] => {
  const nodes = new Map<string, RunNode>(
    runs.map((run) => [run.runId, { run, children: [] }]),
  );
  const roots: RunNode[] = [];
  for (const run of runs) {
    const node = nodes.get(run.runId)!;
    const parent = run.parentRunId === undefined
      ? undefined
      : nodes.get(run.parentRunId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  const byRunId = (left: RunNode, right: RunNode) =>
    left.run.runId.localeCompare(right.run.runId);
  for (const node of nodes.values()) {
    node.children.sort(byRunId);
  }
  return roots;
};

export class KickoffApp extends LitElement {
  static override properties = {
    sessionId: { attribute: false },
    turnId: { attribute: false },
    runs: { attribute: false },
    openRunId: { attribute: false },
    state: { attribute: false },
    running: { attribute: false },
    activity: { attribute: false },
    piece: { attribute: false },
    error: { attribute: false },
  };

  declare sessionId: string | undefined;
  declare turnId: string | undefined;
  declare runs: readonly KickoffRunSummary[];
  declare openRunId: string | undefined;
  declare state: string;
  declare running: boolean;
  /** The last thing the live stream reported, shown while a turn runs. */
  declare activity: string | undefined;
  declare piece: Piece | undefined;
  declare error: string | undefined;

  /** The last sequence rendered; every reconnect resumes from it. */
  #lastSequence = 0;
  #stream: EventSource | undefined;
  /** Run ids known before the running turn started, so its own is spottable. */
  #runIdsBeforeTurn = new Set<string>();

  constructor() {
    super();
    this.runs = [];
    this.state = "idle";
    this.running = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#loadRuns();
    const named = new URLSearchParams(location.search).get("sessionId");
    if (named !== null && named !== "") {
      this.sessionId = named;
      this.#subscribe();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stream?.close();
  }

  async #loadRuns(): Promise<void> {
    try {
      this.runs = await listRuns();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Re-reads the run list and the open run. A run writes its artifacts as it
   * goes, so this is what makes the timeline fill in while a turn is still
   * running; it is driven by a tool completing rather than by a clock.
   */
  async #refresh(): Promise<void> {
    await this.#loadRuns();
    if (this.openRunId === undefined) {
      // The turn's own run is whichever appeared after it started.
      const fresh = this.runs.find((run) =>
        run.parentRunId === undefined && !this.#runIdsBeforeTurn.has(run.runId)
      );
      if (fresh !== undefined) {
        this.openRunId = fresh.runId;
      }
    }
    const view = this.querySelector("kickoff-run-view") as
      | { refresh: () => Promise<void> }
      | null;
    await view?.refresh();
  }

  #subscribe(): void {
    this.#stream?.close();
    const stream = new EventSource(
      `/api/events?sessionId=${
        encodeURIComponent(this.sessionId ?? "")
      }&afterSequence=${this.#lastSequence}`,
    );
    this.#stream = stream;
    stream.addEventListener("chat", (message) => {
      this.#onEvent(JSON.parse((message as MessageEvent<string>).data));
    });
    stream.addEventListener("error", () => {
      if (stream.readyState === EventSource.CLOSED) {
        this.#subscribe();
      }
    });
  }

  #onEvent(envelope: HarnessChatEventEnvelope): void {
    this.#lastSequence = envelope.sequence;
    const event = envelope.event;
    switch (event.kind) {
      case "turn_started":
        this.turnId = event.turn.turnId;
        this.state = "working";
        this.running = true;
        break;
      case "tool_started":
        this.activity = `calling ${event.tool.toolId}`;
        break;
      case "subagent_started":
        this.activity = `delegating to ${event.subagent.profile}`;
        break;
      case "tool_completed":
        this.activity = `${event.tool.toolId} ${event.status}`;
        if (
          event.tool.toolId === "assign_slug" && event.status === "completed"
        ) {
          this.#showPiece(event.resultSummary);
        }
        void this.#refresh();
        break;
      case "turn_completed":
        this.state = "done";
        this.running = false;
        this.activity = undefined;
        void this.#refresh();
        break;
      case "turn_canceled":
        this.state = "canceling";
        break;
      case "status_changed":
        // A canceled turn is still winding down when it says so, and the
        // session reporting no active turn is where it has actually stopped.
        // That is the only end a cancellation has, so the page reads it as one.
        if (event.session.activeTurnId === undefined && this.running) {
          this.state = this.state === "canceling" ? "canceled" : "idle";
          this.running = false;
          this.activity = undefined;
          void this.#refresh();
        }
        break;
      case "turn_failed":
        this.state = "failed";
        this.running = false;
        this.activity = undefined;
        void this.#refresh();
        break;
      default:
        break;
    }
  }

  /**
   * `assign_slug` reports the named address it registered. Its result is the
   * tool message the model read, so the URL is read from there rather than
   * composed here — a space configured by DID carries no URL at all.
   */
  #showPiece(summary: string | undefined): void {
    let parsed: { url?: unknown; slug?: unknown };
    try {
      parsed = JSON.parse(summary ?? "");
    } catch {
      return;
    }
    if (typeof parsed?.url !== "string") {
      return;
    }
    this.piece = {
      url: parsed.url,
      ...(typeof parsed.slug === "string" ? { slug: parsed.slug } : {}),
    };
  }

  async #start(): Promise<void> {
    // The button is disabled while a turn runs, but the attribute is written on
    // the next render rather than on the click, so a second click that lands
    // first is refused here rather than starting a second turn.
    if (this.running) {
      return;
    }
    const input = this.querySelector("#task") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (text === "") {
      return;
    }
    this.running = true;
    this.state = "starting";
    this.error = undefined;
    this.#runIdsBeforeTurn = new Set(this.runs.map((run) => run.runId));
    this.openRunId = undefined;
    if (this.sessionId === undefined) {
      this.piece = undefined;
      this.#lastSequence = 0;
    }
    try {
      const started = await startTask(text, this.sessionId);
      input.value = "";
      this.turnId = started.turnId;
      if (this.sessionId === undefined) {
        this.sessionId = started.sessionId;
        history.replaceState(
          null,
          "",
          `?sessionId=${encodeURIComponent(started.sessionId)}`,
        );
        this.#subscribe();
      }
    } catch (error) {
      this.running = false;
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Asks for the running turn to stop. A refused cancel leaves the turn
   * running, so the page goes back to reporting what the turn is doing and says
   * why it is still doing it.
   */
  async #cancel(): Promise<void> {
    if (this.sessionId === undefined) {
      return;
    }
    const before = this.state;
    this.state = "canceling";
    try {
      await cancelTurn(this.sessionId, this.turnId);
      this.error = undefined;
    } catch (error) {
      this.state = before;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  #runRow(node: RunNode, depth: number): TemplateResult {
    const run = node.run;
    return html`
      <button
        class="run ${this.openRunId === run.runId ? "open" : ""}"
        style="margin-left: ${depth * 0.75}rem"
        type="button"
        @click=${() => this.openRunId = run.runId}
      >
        <div class="run-title">${run.title ?? run.runId}</div>
        <div class="run-meta">
          <span class=${run.status === "failed" ? "bad" : "ok"}>
            ${run.status}
          </span>
          · ${run.toolCallCount}
          ${run.toolCallCount === 1 ? "call" : "calls"}
          ${run.pieceUrls.length === 0
            ? nothing
            : html`· <span class="ok">${run.pieceUrls.length} piece</span>`}
          · ${new Date(run.updatedAt).toLocaleString()}
        </div>
      </button>
      ${node.children.map((child) => this.#runRow(child, depth + 1))}
    `;
  }

  protected override render(): TemplateResult {
    return html`
      <main>
        <header>
          <h1>cf-harness kickoff</h1>
          <span id="state">
            ${this.running && this.activity !== undefined
              ? this.activity
              : this.state}
          </span>
        </header>

        <textarea
          id="task"
          placeholder="Describe what you want built. The harness writes the pattern, runs it in your space, and names the piece."
        ></textarea>
        <div class="controls">
          <button
            type="button"
            ?disabled=${this.running}
            @click=${() => this.#start()}
          >
            ${this.sessionId === undefined ? "Start" : "Send"}
          </button>
          <button
            class="secondary"
            type="button"
            ?disabled=${!this.running}
            @click=${() => this.#cancel()}
          >
            Cancel
          </button>
          ${this.sessionId === undefined ? nothing : html`
            <button
              class="secondary"
              type="button"
              @click=${() => location.href = location.pathname}
            >
              New session
            </button>
          `}
        </div>

        ${this.error === undefined
          ? nothing
          : html`<p class="empty bad">${this.error}</p>`}

        ${this.piece === undefined ? nothing : html`
          <div class="piece">
            <a href=${this.piece.url} rel="noopener" target="_blank">
              Open your piece
            </a>
            <div class="slug">
              ${this.piece.slug === undefined
                ? this.piece.url
                : `${this.piece.slug} — ${this.piece.url}`}
            </div>
          </div>
        `}

        <div class="workbench">
          <div class="run-list">
            <div class="run-list-head">
              <span>Runs</span>
              <button
                class="secondary"
                type="button"
                @click=${() => this.#loadRuns()}
              >
                Refresh
              </button>
            </div>
            ${this.runs.length === 0
              ? html`<p class="empty">No run has been made yet.</p>`
              : runTree(this.runs).map((node) => this.#runRow(node, 0))}
          </div>
          <kickoff-run-view
            .runId=${this.openRunId}
            @open-run=${(event: CustomEvent<string>) =>
              this.openRunId = event.detail}
          ></kickoff-run-view>
        </div>
      </main>
    `;
  }
}

customElements.define("kickoff-app", KickoffApp);
