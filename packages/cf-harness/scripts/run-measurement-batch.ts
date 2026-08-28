#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Run a list of console tasks unattended and write the measurement report.
 *
 * One task per session, one at a time. A fresh session per task is what the
 * measurement rests on — a session that has already searched the index is not
 * a session discovering it — and running them in sequence is what makes an
 * index change attributable to the task that caused it.
 *
 * Nothing here waits on a clock. Each task's completion is the console's own
 * `turn_completed`, `turn_failed` or `turn_canceled` event, read off the
 * server-sent event stream; a turn that never ends is a batch that never ends,
 * which is a hang an operator can see and cancel rather than a bound that
 * turns a slow run into a failed one.
 *
 * [The measurement protocol](../docs/pattern-index-measurement.md) is what
 * says which tasks belong in a suite and how they must be worded. Read it
 * before writing one: **a task must not mention the pattern index.** A task
 * that says "search the index for a counter" measures obedience rather than
 * discovery, and the finding this instrument exists to produce evaporates.
 *
 * Usage:
 *   deno task measure-batch suite.json
 *   deno task measure-batch suite.json --console=http://127.0.0.1:8103
 *   deno task measure-batch suite.json --out=./measurements/tonight
 */

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";

import type {
  HarnessChatEventEnvelope,
  HarnessChatSessionStatus,
} from "../src/contracts/interactive-chat.ts";
import {
  foldTotals,
  measureRunFamily,
  renderRunLines,
  renderTotalsLines,
  type RunFamilyMeasurement,
} from "./measure-runs.ts";

const TOKEN_COOKIE = "cf_harness_console_token";
const CHAT_SSE_EVENT = "chat";
const DEFAULT_CONSOLE_URL = "http://127.0.0.1:8100";

/** The events that close a turn, and therefore settle a task's run on disk. */
const TERMINAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

/** One task of a suite: an identifier to file it under, and its exact text. */
export interface MeasurementTask {
  id: string;
  text: string;
}

/** A suite of tasks, as a suite file holds it. */
export interface MeasurementSuite {
  label: string;
  notes?: string;
  tasks: readonly MeasurementTask[];
}

/**
 * Reads a suite file's contents, or says what is wrong with it.
 *
 * A suite is validated whole before the first task runs. A batch that fails on
 * its fourth task at two in the morning because an entry had no `text` has
 * spent three runs to find out something readable up front.
 */
export const parseMeasurementSuite = (input: unknown): MeasurementSuite => {
  if (typeof input !== "object" || input === null) {
    throw new Error("a task suite must be a JSON object");
  }
  const { label, notes, tasks } = input as Record<string, unknown>;
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("a task suite must carry a non-empty label");
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw new Error("a task suite's notes must be a string");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("a task suite must carry at least one task");
  }
  const seen = new Set<string>();
  const parsed = tasks.map((task, index) => {
    if (typeof task !== "object" || task === null) {
      throw new Error(`task ${index} is not a JSON object`);
    }
    const { id, text } = task as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`task ${index} carries no id`);
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`task ${id} carries no text`);
    }
    if (seen.has(id)) {
      throw new Error(`two tasks share the id ${id}`);
    }
    seen.add(id);
    return { id, text };
  });
  return {
    label,
    ...(notes !== undefined ? { notes } : {}),
    tasks: parsed,
  };
};

/** One frame off a server-sent event stream. */
export interface SseFrame {
  /** The `event:` name, or `undefined` for a comment frame. */
  event?: string;
  data: string;
  id?: number;
}

const decodeSseFrame = (block: string): SseFrame | undefined => {
  let event: string | undefined;
  let id: number | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = Number(value);
  }
  if (event === undefined && data.length === 0) return undefined;
  return {
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
    ...(id !== undefined && Number.isSafeInteger(id) ? { id } : {}),
  };
};

/**
 * The frames of a server-sent event stream, in order.
 *
 * A comment-only block — the `: connected` the console opens every stream with
 * — yields nothing, so a caller counting frames counts what the server said
 * rather than the fact that it answered at all.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = decodeSseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame !== undefined) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Cancelling rather than releasing the lock is what tears the connection
    // down when the consumer stops reading part way, which is the ordinary
    // case here: the terminal envelope arrives and nothing after it is wanted.
    await reader.cancel().catch(() => {});
  }
}

/** What the console answered a started task with. */
export interface StartedTask {
  sessionId: string;
  turnId: string;
}

/** How a turn ended, or why nobody can say. */
export type TurnOutcome =
  | { kind: "turn_completed" | "turn_failed" | "turn_canceled"; detail: string }
  | { kind: "unwitnessed"; reason: string };

/**
 * The fields an index answer may carry to say whether a recorded pattern is
 * offered in search results. Recording a pattern and surfacing it are separate,
 * so an entry can be published and not findable, and a report that treats the
 * two as one misreads the corpus. Several names are accepted because this
 * reader must not decide what the index calls it; the field it read is
 * recorded beside the reading.
 */
const DISCOVERABILITY_FIELDS = [
  "discoverable",
  "findable",
  "searchable",
] as const;

/** One pattern as the index lists it. */
export interface IndexedPattern {
  patternId: string;
  description: string;
  score: number;
  events: Readonly<Record<string, number>>;

  /** Whether the index offers this entry in search results, if it says. */
  discoverable?: boolean;

  /** Which field the reading above came from. */
  discoverabilityField?: string;
}

/** What the index held at one moment, or why it could not be read. */
export type IndexSnapshot =
  | { kind: "read"; patterns: readonly IndexedPattern[] }
  | { kind: "unread"; reason: string };

/** What changed in the index between two snapshots. */
export interface IndexChange {
  added: readonly IndexedPattern[];
  removed: readonly IndexedPattern[];
  rescored: readonly { patternId: string; before: number; after: number }[];
}

/**
 * The difference between two index snapshots, or `undefined` when either end
 * was not read. A diff against a reading nobody took is not a small diff, it
 * is no diff, and reporting it as "nothing changed" would be a lie.
 */
export const indexChangeOf = (
  before: IndexSnapshot,
  after: IndexSnapshot,
): IndexChange | undefined => {
  if (before.kind === "unread" || after.kind === "unread") return undefined;
  const beforeById = new Map(
    before.patterns.map((pattern) => [pattern.patternId, pattern]),
  );
  const afterById = new Map(
    after.patterns.map((pattern) => [pattern.patternId, pattern]),
  );
  const rescored: { patternId: string; before: number; after: number }[] = [];
  for (const [patternId, entry] of afterById) {
    const previous = beforeById.get(patternId);
    if (previous !== undefined && previous.score !== entry.score) {
      rescored.push({
        patternId,
        before: previous.score,
        after: entry.score,
      });
    }
  }
  return {
    added: after.patterns.filter((pattern) =>
      !beforeById.has(pattern.patternId)
    ),
    removed: before.patterns.filter((pattern) =>
      !afterById.has(pattern.patternId)
    ),
    rescored,
  };
};

const indexSnapshotOf = (answer: unknown): IndexSnapshot => {
  if (typeof answer !== "object" || answer === null) {
    return { kind: "unread", reason: "the index answered with no object" };
  }
  const patterns = (answer as Record<string, unknown>).patterns;
  if (!Array.isArray(patterns)) {
    return {
      kind: "unread",
      reason: "the index answered with no pattern list",
    };
  }
  return {
    kind: "read",
    patterns: patterns.map((entry) => {
      const pattern = entry as Record<string, unknown>;
      const discoverabilityField = DISCOVERABILITY_FIELDS.find((field) =>
        typeof pattern[field] === "boolean"
      );
      return {
        patternId: String(pattern.patternId ?? "(unnamed)"),
        description: String(pattern.description ?? ""),
        score: typeof pattern.score === "number" ? pattern.score : Number.NaN,
        events: typeof pattern.events === "object" && pattern.events !== null
          ? pattern.events as Record<string, number>
          : {},
        ...(discoverabilityField === undefined ? {} : {
          discoverable: pattern[discoverabilityField] as boolean,
          discoverabilityField,
        }),
      };
    }),
  };
};

/**
 * One console server, driven the way its own page drives it.
 *
 * `/api` is gated on a token the server hands out as a cookie when the page
 * loads, so the first thing a client does is load the page and keep what it
 * was given. Everything after that carries the cookie.
 */
export class ConsoleClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  /**
   * The sequence of the newest envelope this client has read. Every stream it
   * opens resumes from here, so an envelope emitted between one read and the
   * next arrives in the next stream's backfill rather than being missed.
   */
  #sequence = 0;

  private constructor(
    baseUrl: string,
    token: string,
    fetchImpl: typeof globalThis.fetch,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  static async open(
    baseUrl: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<ConsoleClient> {
    const url = baseUrl.replace(/\/$/, "");
    const response = await fetchImpl(`${url}/`);
    await response.body?.cancel();
    const cookie = response.headers.getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .find((entry) => entry.startsWith(`${TOKEN_COOKIE}=`));
    if (cookie === undefined) {
      throw new Error(
        `${url}/ handed out no ${TOKEN_COOKIE} cookie; is a console server listening there?`,
      );
    }
    return new ConsoleClient(url, cookie, fetchImpl);
  }

  async #json(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        cookie: this.#token,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  }

  /** Starts one task in a new session. */
  async startTask(text: string): Promise<StartedTask> {
    const answer = await this.#json("/api/task", {
      method: "POST",
      body: JSON.stringify({ text }),
    }) as Record<string, unknown>;
    if (
      typeof answer.sessionId !== "string" || typeof answer.turnId !== "string"
    ) {
      throw new Error(
        `/api/task answered without a session and turn: ${
          JSON.stringify(answer)
        }`,
      );
    }
    return { sessionId: answer.sessionId, turnId: answer.turnId };
  }

  /** One session's status, or `undefined` for a session it does not know. */
  async session(
    sessionId: string,
  ): Promise<HarnessChatSessionStatus | undefined> {
    const answer = await this.#json(
      `/api/status?sessionId=${encodeURIComponent(sessionId)}`,
    ) as { sessions?: readonly HarnessChatSessionStatus[] };
    return answer.sessions?.[0];
  }

  /** What the index holds, read through the console's own signed proxy. */
  async indexSnapshot(): Promise<IndexSnapshot> {
    try {
      return indexSnapshotOf(
        await this.#json("/api/index/call", {
          method: "POST",
          body: JSON.stringify({ fn: "listPatterns", body: {} }),
        }),
      );
    } catch (error) {
      return {
        kind: "unread",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Waits for the turn to end, and returns how it ended.
   *
   * The stream is opened after the turn is started rather than before, which
   * is safe because the console backfills every envelope past the sequence the
   * request names: an envelope emitted in the gap arrives in the backfill.
   *
   * A stream the server closes before the turn ends is reopened, and what
   * bounds that is progress rather than a count or a clock. A reconnection
   * that reads no frame at all before its own stream closes is a server that
   * is not going to answer, and the turn is reported unwitnessed. A server
   * that is answering delivers frames — its own liveness ticks if the turn
   * itself is quiet — so a healthy quiet turn is never mistaken for one.
   */
  async awaitTurn(started: StartedTask): Promise<TurnOutcome> {
    for (;;) {
      const response = await this.#fetch(
        `${this.#baseUrl}/api/events?afterSequence=${this.#sequence}`,
        { headers: { cookie: this.#token, accept: "text/event-stream" } },
      );
      if (!response.ok || response.body === null) {
        return {
          kind: "unwitnessed",
          reason: `/api/events answered ${response.status}`,
        };
      }
      let frames = 0;
      for await (const frame of readSseFrames(response.body)) {
        frames += 1;
        if (frame.event !== CHAT_SSE_EVENT) continue;
        const envelope = JSON.parse(frame.data) as HarnessChatEventEnvelope;
        this.#sequence = Math.max(this.#sequence, envelope.sequence);
        if (
          envelope.sessionId !== started.sessionId ||
          !TERMINAL_EVENT_KINDS.has(envelope.event.kind)
        ) {
          continue;
        }
        const event = envelope.event as { kind: string; turnId?: string };
        if (event.turnId !== undefined && event.turnId !== started.turnId) {
          continue;
        }
        return {
          kind: event.kind as Exclude<TurnOutcome, { kind: "unwitnessed" }>[
            "kind"
          ],
          detail: describeTerminalEvent(envelope),
        };
      }
      if (frames === 0) {
        return {
          kind: "unwitnessed",
          reason:
            "the console closed the event stream without delivering a frame",
        };
      }
    }
  }
}

const describeTerminalEvent = (
  envelope: HarnessChatEventEnvelope,
): string => {
  const event = envelope.event;
  if (event.kind === "turn_completed") {
    return event.finalText ?? "(the turn completed with no final text)";
  }
  if (event.kind === "turn_failed") {
    return event.error.message ?? JSON.stringify(event.error);
  }
  if (event.kind === "turn_canceled") {
    return event.reason ?? "(canceled with no reason given)";
  }
  return event.kind;
};

/**
 * What the console was configured with, as one session reports it. Two
 * batches are comparable only if these agree, so the report carries them
 * rather than leaving a reader to remember how the server was started.
 */
export interface SessionConfiguration {
  model?: string;
  cfcEnforcementMode?: string;
}

/** What one task did, as the report records it. */
export interface TaskResult {
  task: MeasurementTask;
  sessionId: string;
  turnId: string;
  outcome: TurnOutcome;
  runId?: string;
  artifactRoot?: string;
  configuration: SessionConfiguration;
  measurement?: RunFamilyMeasurement;
  measurementUnread?: string;
}

/** The whole batch, as the report records it. */
export interface BatchResult {
  suite: MeasurementSuite;
  consoleUrl: string;
  indexUrl: string | null;
  startedAt: string;
  endedAt: string;
  indexBefore: IndexSnapshot;
  indexAfter: IndexSnapshot;
  results: readonly TaskResult[];
}

/** Runs one task and measures the run it left behind. */
export const runTask = async (
  client: ConsoleClient,
  task: MeasurementTask,
  log: (line: string) => void,
): Promise<TaskResult> => {
  log(`task ${task.id}: starting`);
  const started = await client.startTask(task.text);
  const outcome = await client.awaitTurn(started);
  log(`task ${task.id}: ${outcome.kind}`);
  const session = await client.session(started.sessionId);
  const runId = session?.harnessRunId;
  const artifactRoot = session?.artifactRoot;
  const base: TaskResult = {
    task,
    sessionId: started.sessionId,
    turnId: started.turnId,
    outcome,
    ...(runId !== undefined ? { runId } : {}),
    ...(artifactRoot !== undefined ? { artifactRoot } : {}),
    configuration: {
      ...(session?.model !== undefined ? { model: session.model } : {}),
      ...(session?.policy?.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: session.policy.cfcEnforcementMode }
        : {}),
    },
  };
  if (runId === undefined || artifactRoot === undefined) {
    return {
      ...base,
      measurementUnread:
        "the console named no run and artifact root for this session",
    };
  }
  const members: string[] = [];
  try {
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (
        entry.isDirectory &&
        (entry.name === runId || entry.name.startsWith(`${runId}.`))
      ) {
        members.push(entry.name);
      }
    }
  } catch (error) {
    return {
      ...base,
      measurementUnread: `the artifact root could not be listed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    ...base,
    measurement: await measureRunFamily(artifactRoot, runId, members.sort()),
  };
};

const bullet = (lines: readonly string[]): string =>
  lines.length === 0
    ? "- none\n"
    : lines.map((line) => `- ${line}`).join("\n") +
      "\n";

const renderIndexSnapshot = (snapshot: IndexSnapshot): string =>
  snapshot.kind === "unread"
    ? `NOT READ — ${snapshot.reason}`
    : `${snapshot.patterns.length} patterns`;

/**
 * How much of the index is offered in search, when the index says.
 *
 * An index answer with no such field leaves this reading untaken, and it says
 * so: "every entry is findable" and "the answer does not carry the flag" are
 * different readings, and only the second is true of an answer that never
 * mentioned it.
 */
const renderDiscoverability = (snapshot: IndexSnapshot): string => {
  if (snapshot.kind === "unread") {
    return `NOT READ — ${snapshot.reason}\n`;
  }
  const flagged = snapshot.patterns.filter((pattern) =>
    pattern.discoverable !== undefined
  );
  if (flagged.length === 0) {
    return "NOT RECORDED — this index answer carries no discoverability " +
      "flag, so nothing here separates an entry that is recorded from one " +
      "that is offered in search results. Recording and surfacing are " +
      "separate, so do not read the count above as a count of what a run " +
      "could find.\n";
  }
  const field = flagged[0].discoverabilityField;
  const findable = flagged.filter((pattern) => pattern.discoverable).length;
  return `Read from each entry's \`${field}\` field: ${findable} of ${snapshot.patterns.length} entries are offered in search results, ${
    flagged.length - findable
  } are recorded and withheld, and ${
    snapshot.patterns.length - flagged.length
  } carry no flag either way.\n`;
};

const renderIndexChange = (change: IndexChange | undefined): string => {
  if (change === undefined) {
    return "NOT READ — one end of the comparison was never taken, so nothing " +
      "here says the index did or did not change.\n";
  }
  return [
    "Added during the batch:\n",
    bullet(
      change.added.map((pattern) =>
        `\`${pattern.patternId}\` (score ${pattern.score}) — ${pattern.description}`
      ),
    ),
    "\nRemoved during the batch:\n",
    bullet(change.removed.map((pattern) => `\`${pattern.patternId}\``)),
    "\nRescored during the batch:\n",
    bullet(
      change.rescored.map((entry) =>
        `\`${entry.patternId}\`: ${entry.before} → ${entry.after}`
      ),
    ),
  ].join("");
};

/**
 * The standing statement of what a batch report is evidence of.
 *
 * It is fixed text rather than a per-run judgement because the limit is a
 * property of the instrument, not of the night: this reads transcripts, and a
 * transcript records what a run did. No part of this opens a piece, so no
 * number below is a claim that anything the runs built works.
 */
export const REPORT_SCOPE = `## What this report does and does not show

It **counts what each run did**: the searches it issued and what the index
answered them with, whether it ran a published pattern by id or compiled
source of its own, which published patterns that source imported, how much it
delegated, and what it named at the end.

It **does not say whether what a run built works.** Nothing in this report
renders a piece or opens one in a browser. \`run_pattern\` reporting \`ok\`
means the pattern compiled and its result matched the schema it declared — a
pattern whose every cell renders as \`[object Object]\` reports \`ok\` and
publishes clean. Whether a published pattern works is CT-2107's subject, and a
count that is read as answering it is worse than no count at all.

It **does not establish why** a run did what it did. A search that found
nothing and a search the index refused are counted apart here for exactly that
reason: the second says nothing about the corpus.

It **does not say whether a run found what it asked for.** A search hit is a
hit against a *description*, and a description in this index is not reliably a
description of the program behind it: entries advertising a grocery checklist
and a reading list have turned out to be a counter and a program with no
interface at all. So a hit counted here is a hit, not a match.

It **does not read a bare re-export as composition.** Source that imports a
published pattern and exports it unchanged is counted apart from source that
puts one to work, because the index holds entries that are exactly that and
they would otherwise inflate the reading.

**These numbers are comparable to another batch's only if the index readings
above match.** The corpus changes underneath a measurement — entries are
seeded, archived, and rescored between runs — and a change in what the runs did
is as easily an effect of that as of anything in the harness.

A run this could not read is counted as not read, never as a run that did
nothing.
`;

/**
 * What the console was running under, as the sessions reported it.
 *
 * The skills root is deliberately named as not recorded rather than left out.
 * The console scans it before every turn and exposes it over no route, so a
 * batch run against a server started without one is a batch whose runs
 * authored without the authoring guides — a difference that would otherwise be
 * invisible in the report and indistinguishable from an index effect.
 */
const renderConfiguration = (
  results: readonly TaskResult[],
): readonly string[] => {
  const models = new Set(
    results.map((result) => result.configuration.model).filter((model) =>
      model !== undefined
    ),
  );
  const postures = new Set(
    results.map((result) => result.configuration.cfcEnforcementMode).filter((
      mode,
    ) => mode !== undefined),
  );
  const named = (values: ReadonlySet<string>): string =>
    values.size === 0
      ? "NOT RECORDED — no session reported one"
      : [...values].sort().join(", ");
  return [
    "## The console this ran against",
    "",
    `- Model: ${named(models)}`,
    `- CFC enforcement: ${named(postures)}`,
    "- Skills root: NOT RECORDED — the console exposes it over no route; it",
    "  prints the root it scanned at startup, and a batch run against a server",
    "  started without one authored patterns without the authoring guides.",
    "",
  ];
};

/** The batch report, as Markdown. */
export const renderBatchReport = (batch: BatchResult): string => {
  const lines: string[] = [
    `# Pattern index measurement — ${batch.suite.label}`,
    "",
    `- Started: ${batch.startedAt}`,
    `- Ended: ${batch.endedAt}`,
    `- Console: ${batch.consoleUrl}`,
    `- Pattern index: ${
      batch.indexUrl ??
        "not recorded by this runner (the console was started with its own)"
    }`,
    `- Index before: ${renderIndexSnapshot(batch.indexBefore)}`,
    `- Index after: ${renderIndexSnapshot(batch.indexAfter)}`,
    "",
  ];
  if (batch.suite.notes !== undefined) {
    lines.push(batch.suite.notes, "");
  }
  lines.push(
    REPORT_SCOPE,
    "",
    ...renderConfiguration(batch.results),
    "## Batch totals",
    "",
    "```text",
    ...renderTotalsLines(
      foldTotals(
        batch.results.map((result) => result.measurement?.totals).filter((
          totals,
        ): totals is NonNullable<typeof totals> => totals !== undefined),
      ),
    ),
    "```",
    "",
    `Tasks: ${batch.results.length}, of which ${
      batch.results.filter((result) => result.measurement === undefined).length
    } were not measured.`,
    "",
    "## The index, before and after",
    "",
    "How much of it a run could find, going in:",
    "",
    renderDiscoverability(batch.indexBefore),
    renderIndexChange(indexChangeOf(batch.indexBefore, batch.indexAfter)),
    "## The tasks",
    "",
    "Each task ran in a fresh session, one at a time, and none of them names",
    "the pattern index. The text below is what the session was given, exactly.",
    "",
  );
  for (const result of batch.results) {
    lines.push(
      `### ${result.task.id}`,
      "",
      "```text",
      result.task.text,
      "```",
      "",
      `- Session: \`${result.sessionId}\``,
      `- Run: ${result.runId === undefined ? "none" : `\`${result.runId}\``}`,
      `- Ended: **${result.outcome.kind}** — ${
        result.outcome.kind === "unwitnessed"
          ? result.outcome.reason
          : result.outcome.detail.split("\n")[0]
      }`,
      "",
    );
    if (result.measurement === undefined) {
      lines.push(
        `NOT MEASURED — ${result.measurementUnread ?? "no reason recorded"}`,
        "",
      );
      continue;
    }
    lines.push("```text");
    for (const run of result.measurement.runs) {
      lines.push(...renderRunLines(run));
    }
    lines.push(...renderTotalsLines(result.measurement.totals));
    lines.push("```", "");
  }
  return lines.join("\n");
};

export const main = async (
  args: readonly string[],
  log: (line: string) => void = console.log,
): Promise<number> => {
  const flags = parseArgs([...args], {
    string: ["console", "out"],
    default: { console: DEFAULT_CONSOLE_URL },
  });
  const suitePath = flags._.map(String)[0];
  if (suitePath === undefined) {
    log("usage: measure-batch <suite.json> [--console=URL] [--out=DIR]");
    return 2;
  }
  const suite = parseMeasurementSuite(
    JSON.parse(await Deno.readTextFile(suitePath)),
  );
  const client = await ConsoleClient.open(flags.console);
  const startedAt = new Date().toISOString();
  const indexBefore = await client.indexSnapshot();
  log(`index before: ${renderIndexSnapshot(indexBefore)}`);
  const results: TaskResult[] = [];
  for (const task of suite.tasks) {
    results.push(await runTask(client, task, log));
  }
  const indexAfter = await client.indexSnapshot();
  log(`index after: ${renderIndexSnapshot(indexAfter)}`);
  const batch: BatchResult = {
    suite,
    consoleUrl: flags.console,
    indexUrl: Deno.env.get("CF_HARNESS_PATTERN_INDEX_URL") ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    indexBefore,
    indexAfter,
    results,
  };
  const outDir = flags.out ??
    join(
      ".cf-harness-console",
      "measurements",
      `${startedAt.replace(/[:.]/g, "-")}`,
    );
  await ensureDir(outDir);
  await Deno.writeTextFile(
    join(outDir, "report.md"),
    renderBatchReport(batch),
  );
  await Deno.writeTextFile(
    join(outDir, "report.json"),
    `${JSON.stringify(batch, null, 2)}\n`,
  );
  log(`report written to ${join(outDir, "report.md")}`);
  return results.every((result) => result.outcome.kind === "turn_completed")
    ? 0
    : 1;
};

if (import.meta.main) Deno.exit(await main(Deno.args));
