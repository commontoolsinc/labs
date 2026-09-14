/**
 * A per-person lens over ONE topic: the topic's summary, the agent sessions
 * attached to it, the sessions that look related, the topic's links, and a
 * composer that starts a new session for the topic.
 *
 * It is a piece in the PERSON's own space rather than a change to the topic,
 * because agent sessions are published owner-confidential by the agents
 * connector while the topic lives on a shared board. The workbench holds a
 * reference to the topic and reads the person's connector index; nothing here
 * writes into the topic.
 *
 * Attachments are the workbench's own record, sessions are read from the
 * connector's complete index, and "start a session" sends the connector a
 * `start` command through a queue the connector's host binds to this
 * pattern's own handler. A start is recorded as pending until the index
 * carries the session it named; only then does it count as attached, since
 * the queue may not be bound yet or the connector may refuse the start. The
 * composed shell command stays as the fallback for a person whose host has
 * no queue for this piece.
 */
import {
  action,
  computed,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  type PerSession,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

import {
  isSafeLinkUrl,
  snippet,
  TOPICS_THEME,
  whenLabel,
} from "../topics/topic.tsx";

// ===== Views of what this reads =====

/** What the workbench reads of the topic it is about — a narrow view, never
 * the whole piece. Every field carries a default so a topic written before a
 * field existed still reads. */
export interface TopicView {
  title: string | Default<"">;
  shortName?: string;
  body: string | Default<"">;
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
  createdBy?:
    | { kind: string; name: string; avatar?: string }
    | Default<{ kind: "person"; name: "" }>;
  links: TopicLinkView[] | Default<[]>;
}

export interface TopicLinkView {
  kind: string;
  url: string;
  label?: string;
  addedAt?: number;
  removedAt?: number;
}

/** One session row of the agents connector's index, as this workbench reads
 * it: the shallow fields and nothing under the manifest. */
export interface SessionEntry {
  sourceId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  updatedAt: string | null;
  active: boolean | null;
  archived: boolean | null;
  syncStatus: string;
}

/** One checkout the connector discovered below its configured roots. */
export interface CheckoutEntry {
  root: string;
  branch?: string | null;
  commit?: string | null;
}

/** One source the connector collects, as the index's status rows name it. */
export interface SourceEntry {
  id: string;
  driver: string;
}

/** The index's source rows to the depth the harness picker reads: the row
 * and the one capability the workbench acts on, whether the driver can start
 * a session (the connector publishes each driver's capabilities). Declared
 * apart from `SessionIndexView`, which is the piece's argument contract: a
 * typed field added inside that contract's `SourceEntry | undefined`
 * alternatives is a narrowing the update-compatibility check refuses, while a
 * lift's own parameter type is what bounds its read. */
export interface StartableSourcesView {
  sources?: Array<
    | { id: string; driver: string; capabilities?: { startSession?: boolean } }
    | undefined
  >;
}

/** A JSON-encoded connector command, as the connector's queues hold them. */
export type CommandValue = string;

/** The connector's session index, declared to the depth the workbench reads.
 * Every array element the connector publishes is a linked child cell; the
 * `undefined` branch is a child that has not loaded yet, and the reads below
 * skip it. Declared inline, the way a board declares its linked topics: this
 * workbench reads the shallow fields and never forwards a row as a cell. */
export interface SessionIndexView {
  schema: string;
  /** The connector owner's DID; every command the workbench sends names it. */
  ownerDid?: string;
  generatedAt?: string;
  sources?: Array<SourceEntry | undefined>;
  sessions: Array<SessionEntry | undefined>;
  checkouts?: Array<CheckoutEntry | undefined>;
}

/** A session this workbench has attached to its topic. The key is provider
 * identity, so the row stays attached across renames and reconnections. */
export interface Attachment {
  sourceId: string;
  nativeSessionId: string;
  title: string;
  attachedAt: number;
}

/** A start this workbench has sent and the connector has not yet shown as a
 * session: the command may be waiting on a queue the host has not bound, or
 * the connector may have refused it. Once the index carries the session, the
 * start counts as an attachment; until then it shows as starting and can be
 * dismissed. */
export interface PendingStart {
  commandId: string;
  sourceId: string;
  nativeSessionId: string;
  title: string;
  startedAt: number;
}

/** A session as the workbench shows it: the index row joined with whether it
 * is attached. Plain values, derived on read. */
export interface SessionRow {
  key: string;
  sourceId: string;
  nativeSessionId: string;
  title: string;
  cwd: string;
  gitBranch: string;
  gitRepo: string;
  updatedAt: string;
  active: boolean;
  attached: boolean;
}

export interface CheckoutOption {
  label: string;
  value: string;
}

// ===== Verbs =====

export interface AttachEvent {
  sourceId: string;
  nativeSessionId: string;
  /** The title as known at attach time; the live title comes from the index. */
  title?: string;
}

export interface AttachResult {
  attachedAt: number;
  /** False when the session was already attached; the call is idempotent. */
  added: boolean;
}

export interface DetachEvent {
  sourceId: string;
  nativeSessionId: string;
}

// ===== Inputs and outputs =====

export interface WorkbenchInput {
  /** The topic this workbench is about, linked from the board's topic piece. */
  topic?: TopicView;
  /** The agents connector's complete session index for this person. */
  sessions?: SessionIndexView;
  /** Sessions attached to the topic, the workbench's own durable record. */
  attached?: Writable<Attachment[] | Default<[]>>;
  /**
   * The command queue the connector's host binds for this piece. Absent until
   * the host has linked it; a start sent before then reaches nothing.
   */
  commands?: Writable<CommandValue[] | Default<[]>>;
  /** Starts sent and not yet confirmed by the index, the workbench's own
   * record. */
  pendingStarts?: Writable<PendingStart[] | Default<[]>>;
}

export interface WorkbenchOutput {
  [NAME]: string;
  [UI]: VNode;
  attached: Attachment[] | Default<[]>;
  /** The attached sessions, the confirmed starts among them. */
  attachedSessions: SessionRow[];
  /** Starts the index has not confirmed yet. */
  pendingStarts: PendingStart[];
  relatedSessions: SessionRow[];
  recentSessions: SessionRow[];
  spawnCommand: string;
  /** The prompt as it will be sent: the person's words, then the topic's
   * context and links. */
  kickoff: string;
  spawnPrompt: PerSession<Writable<string>>;
  spawnRoot: PerSession<Writable<string>>;
  spawnSource: PerSession<Writable<string>>;
  /** Attach a session by provider identity. Idempotent. */
  attach: Stream<AttachEvent, AttachResult>;
  /** Detach a session by provider identity. */
  detach: Stream<DetachEvent>;
  /**
   * Start a session for the topic: sends the connector a `start` command
   * carrying the kickoff prompt, the picked checkout, and the topic's name as
   * the session title, and records the start as pending until the index
   * carries the session.
   */
  startSession: Stream<void>;
  // The connector's host reads this field's schema to learn which handler may
  // write the queue it binds for this piece. The field has no stored value.
  commandAuthorization?: WriteAuthorizedBy<
    boolean,
    typeof startSessionCommand
  >;
}

// ===== Derivations =====
//
// Module-scope lifts, because the declared parameter is what bounds the read.

export const sessionKey = (sourceId: string, nativeSessionId: string): string =>
  `${sourceId}/${nativeSessionId}`;

/** Whether the index carries a session in any state. A row the connector
 * has since marked deleted still confirms that the session existed, so a
 * confirmed start stays attached, showing from its own record the way a
 * manually attached session does once the index drops it. */
const indexCarries = (
  index: SessionIndexView | undefined,
  sourceId: string,
  nativeSessionId: string,
): boolean =>
  (index?.sessions ?? []).some((s) =>
    s !== undefined && s.sourceId === sourceId &&
    s.nativeSessionId === nativeSessionId
  );

/** The pending starts the index has confirmed, as attachments: the connector
 * published the session the start named, so it is the person's. */
export const confirmedStartsOf = lift((
  { pending, index }: {
    pending: PendingStart[] | Default<[]>;
    index?: SessionIndexView;
  },
): Attachment[] =>
  pending.filter((p) => indexCarries(index, p.sourceId, p.nativeSessionId))
    .map((p) => ({
      sourceId: p.sourceId,
      nativeSessionId: p.nativeSessionId,
      title: p.title,
      attachedAt: p.startedAt,
    }))
);

/** The pending starts the index has not confirmed: still starting, or refused
 * by the connector, which the person can dismiss. */
export const unconfirmedStartsOf = lift((
  { pending, index }: {
    pending: PendingStart[] | Default<[]>;
    index?: SessionIndexView;
  },
): PendingStart[] =>
  pending.filter((p) => !indexCarries(index, p.sourceId, p.nativeSessionId))
);

/** The attachments and the confirmed starts as one list, one per session,
 * in the order they were attached or started. */
export const attachmentsOf = lift((
  { attached, confirmed }: {
    attached: Attachment[] | Default<[]>;
    confirmed: Attachment[];
  },
): Attachment[] => {
  const keys = new Set(
    attached.map((a) => sessionKey(a.sourceId, a.nativeSessionId)),
  );
  return [
    ...attached,
    ...confirmed.filter((c) =>
      !keys.has(sessionKey(c.sourceId, c.nativeSessionId))
    ),
  ].toSorted((a, b) => a.attachedAt - b.attachedAt);
});

/** Every session the index holds, newest first, with the fields the rows
 * render. Reads the shallow row and nothing under the manifest. */
const sessionRowsOf = lift((
  { index, attached }: {
    index?: SessionIndexView;
    attached: Attachment[] | Default<[]>;
  },
): SessionRow[] => {
  const attachedKeys = new Set(
    attached.map((a) => sessionKey(a.sourceId, a.nativeSessionId)),
  );
  const rows: SessionRow[] = [];
  for (const s of index?.sessions ?? []) {
    if (!s || s.syncStatus === "deleted") continue;
    const key = sessionKey(s.sourceId, s.nativeSessionId);
    rows.push({
      key,
      sourceId: s.sourceId,
      nativeSessionId: s.nativeSessionId,
      title: s.title ?? "",
      cwd: s.cwd ?? "",
      gitBranch: s.gitBranch ?? "",
      gitRepo: s.gitRepo ?? "",
      updatedAt: s.updatedAt ?? "",
      active: s.active === true,
      attached: attachedKeys.has(key),
    });
  }
  return rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

/** The attached sessions, in attach order, each joined with its live row when
 * the index still carries it. A session the index no longer holds still shows,
 * from the attachment's own record, so an attachment never silently vanishes. */
const attachedRowsOf = lift((
  { attached, rows }: {
    attached: Attachment[] | Default<[]>;
    rows: SessionRow[];
  },
): SessionRow[] =>
  attached.map((a) => {
    const key = sessionKey(a.sourceId, a.nativeSessionId);
    return rows.find((r) => r.key === key) ?? {
      key,
      sourceId: a.sourceId,
      nativeSessionId: a.nativeSessionId,
      title: a.title,
      cwd: "",
      gitBranch: "",
      gitRepo: "",
      updatedAt: "",
      active: false,
      attached: true,
    };
  })
);

/** Sessions that name the topic without being attached: the topic's number
 * or its title appears in the session's title. A suggestion, not a claim. */
const relatedRowsOf = lift((
  { rows, shortName, title }: {
    rows: SessionRow[];
    shortName: string;
    title: string;
  },
): SessionRow[] => {
  // The number matches as a whole token, so `#1` does not claim `#10`.
  const number = shortName.trim();
  const numberPattern = number
    ? new RegExp(
      `(?:#|top/)${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`,
      "i",
    )
    : undefined;
  const titleNeedle = title.trim().toLowerCase();
  if (!numberPattern && titleNeedle.length < 3) return [];
  return rows.filter((r) =>
    !r.attached && (
      (numberPattern?.test(r.title) ?? false) ||
      (titleNeedle.length >= 3 && r.title.toLowerCase().includes(titleNeedle))
    )
  );
});

/** The newest unattached sessions, bounded. */
const recentRowsOf = lift((
  { rows, limit }: { rows: SessionRow[]; limit: number },
): SessionRow[] => rows.filter((r) => !r.attached).slice(0, limit));

/** The topic's links still present, PRs first. */
const presentLinksOf = lift((
  { links }: { links?: TopicLinkView[] | Default<[]> },
): TopicLinkView[] =>
  (links ?? []).filter((l) => l.removedAt === undefined).toSorted((a, b) =>
    (a.kind === "pr" ? 0 : 1) - (b.kind === "pr" ? 0 : 1)
  )
);

/** The connector's sources whose driver can start a session, as picker
 * options; Claude sources first. A source that cannot start (the Codex and
 * ACP drivers today) is not offered, since a start through it would queue a
 * command the connector refuses. */
const sourceOptionsOf = lift((
  { index }: { index?: StartableSourcesView },
): CheckoutOption[] =>
  (index?.sources ?? [])
    .flatMap((source) =>
      source?.id && source.capabilities?.startSession === true
        ? [{ label: `${source.id}  (${source.driver})`, value: source.id }]
        : []
    )
    .toSorted((a, b) =>
      (a.label.includes("claude-agent-sdk") ? 0 : 1) -
      (b.label.includes("claude-agent-sdk") ? 0 : 1)
    )
);

/** Checkouts the connector discovered, as picker options. */
const checkoutOptionsOf = lift((
  { index }: { index?: SessionIndexView },
): CheckoutOption[] =>
  (index?.checkouts ?? []).flatMap((c) =>
    c?.root
      ? [{
        label: c.branch ? `${c.root}  (${c.branch})` : c.root,
        value: c.root,
      }]
      : []
  )
);

/** The prompt a session for this topic starts from: the topic's number and
 * title, and the head of its living document. */
const defaultPromptOf = lift((
  { shortName, title }: {
    shortName: string;
    title: string;
  },
): string => {
  // One sentence. The kickoff's context block carries the document excerpt,
  // so the sentence must not repeat it.
  const name = shortName ? `topic #${shortName}` : "the topic";
  return title.trim() ? `Work on ${name}, "${title}".` : "";
});

/** The prompt a session actually starts from: the person's own words first,
 * then the topic's context, then the links. The person's words are never
 * replaced; an empty box falls back to the default sentence. */
const kickoffOf = lift((
  { prompt, defaultPrompt, shortName, title, body, links }: {
    prompt: string;
    defaultPrompt: string;
    shortName: string;
    title: string;
    body: string;
    links: TopicLinkView[];
  },
): string => {
  const head = prompt.trim() || defaultPrompt;
  if (!title.trim()) return head;
  const name = shortName ? `Topic #${shortName}` : "The topic";
  const opening = snippet(body, 400);
  const context = opening
    ? `${name}, "${title}". Its living document begins: ${opening}`
    : `${name}, "${title}".`;
  // Only links that are http(s) go into a prompt; a stored link that is not
  // (written before the topic's guard) renders as text and is not repeated.
  const urls = links.filter((l) => l.kind === "pr" && isSafeLinkUrl(l.url))
    .map((l) => `- ${l.label ? `${l.label}: ` : ""}${l.url}`);
  return [
    head,
    `Context:\n- ${context}`,
    ...(urls.length ? [`Links:\n${urls.join("\n")}`] : []),
  ].join("\n\n");
});

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command to paste until the connector can start a session itself. */
const spawnCommandOf = lift((
  { root, prompt }: { root: string; prompt: string },
): string =>
  root.trim()
    ? `cd ${shellQuote(root.trim())} && claude ${shellQuote(prompt)}`
    : `claude ${shellQuote(prompt)}`
);

const whenIso = (iso: string): string =>
  iso ? iso.replace("T", " ").slice(0, 16) : "";

const tail = (path: string, parts = 2): string =>
  path.split("/").filter(Boolean).slice(-parts).join("/");

/** The one-line caption under a session's title. Module scope, because a
 * callable used inside a reactive `.map()` must be self-contained. */
const captionOf = (row: SessionRow): string =>
  [
    row.sourceId,
    row.gitBranch,
    row.cwd ? tail(row.cwd) : "",
    row.updatedAt ? whenIso(row.updatedAt) : "",
  ].filter((part) => part.length > 0).join(" · ");

// ===== Handlers (browser) =====

/** The key an attachment's or a pending start's record lives under: one per
 * session. */
export const attachmentKey = (
  sourceId: string,
  nativeSessionId: string,
): string => JSON.stringify([sourceId, nativeSessionId]);

/** Records the attachment when none is there and adds it to the list: a
 * keyed record and an add-if-absent membership, so the same person writing
 * from two tabs or a session's own skill do not overwrite each other. True
 * when the record was new. */
export const recordAttachment = (
  attached: Writable<Attachment[] | Default<[]>>,
  attachment: Attachment,
): boolean => {
  const record = attached.elementById(
    attachmentKey(attachment.sourceId, attachment.nativeSessionId),
  );
  const added = record.get() === undefined;
  if (added) record.set(attachment);
  attached.addUnique(record);
  return added;
};

/** Drops a session's attachment and clears its record, so a later attach of
 * the same session starts fresh rather than reviving this one. */
export const dropAttachment = (
  attached: Writable<Attachment[] | Default<[]>>,
  sourceId: string,
  nativeSessionId: string,
): void => {
  const key = attachmentKey(sourceId, nativeSessionId);
  attached.removeByValue(attached.elementById(key));
  const record: Writable<Attachment | undefined> = attached.elementById(key);
  record.set(undefined);
};

/** Records a start as pending, keyed by the session it named. */
export const recordPendingStart = (
  pending: Writable<PendingStart[] | Default<[]>>,
  start: PendingStart,
): void => {
  const record = pending.elementById(
    attachmentKey(start.sourceId, start.nativeSessionId),
  );
  record.set(start);
  pending.addUnique(record);
};

/** Drops a pending start and clears its record: the person dismissed it, or
 * detached the session it became. */
export const dropPendingStart = (
  pending: Writable<PendingStart[] | Default<[]>>,
  sourceId: string,
  nativeSessionId: string,
): void => {
  const key = attachmentKey(sourceId, nativeSessionId);
  pending.removeByValue(pending.elementById(key));
  const record: Writable<PendingStart | undefined> = pending.elementById(key);
  record.set(undefined);
};

/** The source a start goes through: the picked one, else the first offered,
 * and only when it is one that can start; "" otherwise. */
export const startSourceOf = (
  picked: string,
  options: readonly CheckoutOption[],
  startable: readonly string[],
): string => {
  const sourceId = (picked || options[0]?.value || "").trim();
  return startable.includes(sourceId) ? sourceId : "";
};

/** A connector `start` command, JSON-encoded as its queue holds it, and the
 * id it carries. */
export const startCommandValue = (
  { ownerDid, idPrefix, sourceId, nativeSessionId, text, cwd, title, mode }: {
    ownerDid: string;
    idPrefix: string;
    sourceId: string;
    nativeSessionId: string;
    text: string;
    cwd: string;
    title: string;
    mode?: string;
  },
): { id: string; value: CommandValue } => {
  const createdAt = new Date().toISOString();
  const id = `${idPrefix}:${createdAt}:${nativeSessionId.slice(0, 8)}`;
  return {
    id,
    value: JSON.stringify({
      schema: "commonfabric.agent-connector.command",
      ownerDid,
      id,
      createdAt,
      sourceId,
      nativeSessionId,
      type: "start",
      payload: {
        text,
        ...(cwd ? { cwd } : {}),
        ...(title ? { title } : {}),
        ...(mode ? { mode } : {}),
      },
    }),
  };
};

const attachFromRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
  title: string;
}>((_, { attached, sourceId, nativeSessionId, title }) => {
  recordAttachment(attached, {
    sourceId,
    nativeSessionId,
    title,
    attachedAt: Date.now(),
  });
});

const detachFromRow = handler<void, {
  attached: Writable<Attachment[] | Default<[]>>;
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
}>((_, { attached, pendingStarts, sourceId, nativeSessionId }) => {
  // A confirmed start is attached through its pending record; detaching
  // drops whichever record the session has.
  dropAttachment(attached, sourceId, nativeSessionId);
  dropPendingStart(pendingStarts, sourceId, nativeSessionId);
});

const dismissStart = handler<void, {
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  sourceId: string;
  nativeSessionId: string;
}>((_, { pendingStarts, sourceId, nativeSessionId }) => {
  dropPendingStart(pendingStarts, sourceId, nativeSessionId);
});

const useDefaultPrompt = handler<void, {
  spawnPrompt: Writable<string>;
  defaultPrompt: string;
}>((_, { spawnPrompt, defaultPrompt }) => {
  // Add to what the person typed; never replace it.
  const current = spawnPrompt.get().trim();
  spawnPrompt.set(current ? `${current}\n\n${defaultPrompt}` : defaultPrompt);
});

/** A version 4 UUID, which is the shape a Claude session id must have. */
const mintSessionId = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

/**
 * Sends the connector a `start` command and records the start as pending.
 * Exported because the connector's host binds this piece's queue to this
 * handler by name: only a write from here is accepted on that queue.
 */
export const startSessionCommand = handler<void, {
  commands: Writable<CommandValue[] | Default<[]>>;
  pendingStarts: Writable<PendingStart[] | Default<[]>>;
  spawnRoot: Writable<string>;
  spawnSource: Writable<string>;
  sourceOptions: CheckoutOption[];
  kickoff: string;
  ownerDid: string;
  shortName: string;
  title: string;
}>((_, state) => {
  // The options are the sources that can start; a picker value naming any
  // other (a source that lost the capability, a stale choice) starts nothing.
  const sourceId = startSourceOf(
    state.spawnSource.get(),
    state.sourceOptions,
    state.sourceOptions.map((option) => option.value),
  );
  if (!state.ownerDid || !sourceId || !state.kickoff.trim()) return;
  const nativeSessionId = mintSessionId();
  const sessionTitle = state.shortName
    ? `topic #${state.shortName}: ${state.title}`
    : state.title;
  const command = startCommandValue({
    ownerDid: state.ownerDid,
    idPrefix: "workbench",
    sourceId,
    nativeSessionId,
    text: state.kickoff,
    cwd: state.spawnRoot.get().trim(),
    title: sessionTitle,
  });
  state.commands.push(command.value);
  // Pending, not attached: nothing here knows whether a queue took the
  // command or the connector accepted it. The start shows as starting until
  // the index carries the session, and can be dismissed if it never does.
  recordPendingStart(state.pendingStarts, {
    commandId: command.id,
    sourceId,
    nativeSessionId,
    title: sessionTitle,
    startedAt: Date.now(),
  });
});

// ===== The pattern =====

export default pattern<WorkbenchInput, WorkbenchOutput>(
  ({ topic, sessions, attached, commands, pendingStarts }) => {
    const spawnPrompt = new Writable.perSession("");
    const spawnRoot = new Writable.perSession("");
    const spawnSource = new Writable.perSession("");

    const title = topic?.title ?? "";
    const shortName = topic?.shortName ?? "";
    const body = topic?.body ?? "";
    const commentCount = topic?.commentCount ?? 0;
    const lastActivityAt = topic?.lastActivityAt ?? 0;
    const hasTopic = title.trim().length > 0;
    const hasBody = body.trim().length > 0;

    const confirmedStarts = confirmedStartsOf({
      pending: pendingStarts,
      index: sessions,
    });
    const attachments = attachmentsOf({ attached, confirmed: confirmedStarts });
    const startingSessions = unconfirmedStartsOf({
      pending: pendingStarts,
      index: sessions,
    });
    const rows = sessionRowsOf({ index: sessions, attached: attachments });
    const attachedSessions = attachedRowsOf({ attached: attachments, rows });
    const relatedSessions = relatedRowsOf({ rows, shortName, title });
    const recentSessions = recentRowsOf({ rows, limit: 8 });
    const links = presentLinksOf({ links: topic?.links });
    const checkoutOptions = checkoutOptionsOf({ index: sessions });
    const sourceOptions = sourceOptionsOf({ index: sessions });
    const ownerDid = sessions?.ownerDid ?? "";
    const defaultPrompt = defaultPromptOf({ shortName, title });
    const kickoff = kickoffOf({
      prompt: spawnPrompt,
      defaultPrompt,
      shortName,
      title,
      body,
      links,
    });
    const spawnCommand = spawnCommandOf({ root: spawnRoot, prompt: kickoff });
    const startSession = startSessionCommand({
      commands,
      pendingStarts,
      spawnRoot,
      spawnSource,
      sourceOptions,
      kickoff,
      ownerDid,
      shortName,
      title,
    });

    const hasAttached = attachedSessions.length > 0;
    const hasStarting = startingSessions.length > 0;
    const hasRelated = relatedSessions.length > 0;
    const hasRecent = recentSessions.length > 0;
    const hasLinks = links.length > 0;
    const hasIndex = computed(() => rows.length > 0);
    const hasPrompt = computed(() =>
      spawnPrompt.get().trim().length > 0 || hasTopic
    );

    // --- Verbs (headless; a skill inside a session can attach itself) ---

    const attach = action<AttachEvent, AttachResult>(
      ({ sourceId, nativeSessionId, title: given }) => {
        const source = (sourceId ?? "").trim();
        const native = (nativeSessionId ?? "").trim();
        if (!source || !native) {
          throw new Error("attach: sourceId and nativeSessionId are required");
        }
        const attachedAt = Date.now();
        const added = recordAttachment(attached, {
          sourceId: source,
          nativeSessionId: native,
          title: (given ?? "").trim(),
          attachedAt,
        });
        return { attachedAt, added };
      },
    );

    const detach = action<DetachEvent>(({ sourceId, nativeSessionId }) => {
      const source = (sourceId ?? "").trim();
      const native = (nativeSessionId ?? "").trim();
      dropAttachment(attached, source, native);
      dropPendingStart(pendingStarts, source, native);
    });

    return {
      [NAME]: hasTopic ? `Workbench: ${title}` : "Workbench (no topic)",
      [UI]: (
        <cf-theme theme={TOPICS_THEME}>
          <cf-screen>
            <cf-vstack slot="header" gap="1" padding="4">
              <cf-hstack gap="2" align="center">
                {shortName
                  ? (
                    <cf-badge size="sm" color="primary" data-member-name="">
                      {shortName}
                    </cf-badge>
                  )
                  : null}
                <cf-text
                  block
                  style="font-size: 1.25rem; font-weight: 600; flex: 1; min-width: 0;"
                >
                  {hasTopic ? title : "No topic linked yet"}
                </cf-text>
              </cf-hstack>
              <cf-text variant="caption" tone="muted">
                {hasTopic
                  ? `Your part of it · ${attachedSessions.length} sessions attached · ${recentSessions.length} recent · ${links.length} links · ${commentCount} comments · last activity ${
                    whenLabel(lastActivityAt)
                  }`
                  : "Link a topic into this workbench's `topic` input."}
              </cf-text>
            </cf-vstack>

            <cf-vstack gap="3" padding="4">
              {/* Two panes side by side; one column when the window is narrow. */}
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr)); gap: 0.75rem; align-items: start;">
                {/* ── Left: the topic's own material ── */}
                <cf-vstack gap="3" style="min-width: 0;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Living document</cf-heading>
                      {hasBody
                        ? <cf-markdown content={body} />
                        : (
                          <cf-text tone="muted" block>
                            The topic has no body yet.
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>Links</cf-heading>
                        <cf-text variant="caption" tone="muted">
                          PRs first
                        </cf-text>
                      </cf-hstack>
                      {hasLinks
                        ? (
                          <cf-vstack gap="1">
                            {links.map((link) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-link-row=""
                              >
                                <cf-badge
                                  size="xs"
                                  color={link.kind === "pr"
                                    ? "primary"
                                    : "neutral"}
                                >
                                  {link.kind}
                                </cf-badge>
                                {isSafeLinkUrl(link.url)
                                  ? (
                                    <a
                                      href={link.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                                    >
                                      {link.label || link.url}
                                    </a>
                                  )
                                  : (
                                    <cf-text
                                      tone="muted"
                                      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                                    >
                                      {link.label || link.url}
                                    </cf-text>
                                  )}
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            The topic has no links yet.
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>

                {/* ── Right: your sessions, and the next one ── */}
                <cf-vstack gap="3" style="min-width: 0;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>
                          Sessions on this topic
                        </cf-heading>
                        <cf-text variant="caption" tone="muted">
                          {attachedSessions.length} attached
                        </cf-text>
                      </cf-hstack>
                      {hasAttached
                        ? (
                          <cf-vstack gap="2">
                            {attachedSessions.map((row) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-session-row=""
                              >
                                <span
                                  style={`display:inline-block;width:0.5rem;height:0.5rem;border-radius:50%;flex:0 0 auto;background:${
                                    row.active ? "#2A7A55" : "#C2CAD0"
                                  }`}
                                >
                                </span>
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {row.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {captionOf(row)}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  data-detach=""
                                  onClick={detachFromRow({
                                    attached,
                                    pendingStarts,
                                    sourceId: row.sourceId,
                                    nativeSessionId: row.nativeSessionId,
                                  })}
                                >
                                  Detach
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            No sessions attached. Attach one below, or start
                            one.
                          </cf-text>
                        )}
                      {hasStarting
                        ? (
                          <cf-vstack gap="2" data-starting="">
                            <cf-text variant="caption" tone="muted">
                              Starting · {startingSessions.length}
                            </cf-text>
                            {startingSessions.map((start) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-starting-row=""
                              >
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {start.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {`${start.sourceId} · sent to the connector; attaches when the session appears in the index`}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  data-dismiss=""
                                  onClick={dismissStart({
                                    pendingStarts,
                                    sourceId: start.sourceId,
                                    nativeSessionId: start.nativeSessionId,
                                  })}
                                >
                                  Dismiss
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : null}
                    </cf-vstack>
                  </cf-card>

                  {hasRelated
                    ? (
                      <cf-card>
                        <cf-vstack gap="2">
                          <cf-hstack justify="between" align="center">
                            <cf-heading level={5}>Looks related</cf-heading>
                            <cf-text variant="caption" tone="muted">
                              titles that name this topic
                            </cf-text>
                          </cf-hstack>
                          <cf-vstack gap="2">
                            {relatedSessions.map((row) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-session-row=""
                              >
                                <span
                                  style={`display:inline-block;width:0.5rem;height:0.5rem;border-radius:50%;flex:0 0 auto;background:${
                                    row.active ? "#2A7A55" : "#C2CAD0"
                                  }`}
                                >
                                </span>
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {row.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {captionOf(row)}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="secondary"
                                  size="sm"
                                  data-attach=""
                                  onClick={attachFromRow({
                                    attached,
                                    sourceId: row.sourceId,
                                    nativeSessionId: row.nativeSessionId,
                                    title: row.title,
                                  })}
                                >
                                  Attach
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    )
                    : null}

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={5}>Recent sessions</cf-heading>
                        <cf-text variant="caption" tone="muted">
                          newest first
                        </cf-text>
                      </cf-hstack>
                      {hasRecent
                        ? (
                          <cf-vstack gap="2">
                            {recentSessions.map((row) => (
                              <cf-hstack
                                gap="2"
                                align="center"
                                data-session-row=""
                              >
                                <span
                                  style={`display:inline-block;width:0.5rem;height:0.5rem;border-radius:50%;flex:0 0 auto;background:${
                                    row.active ? "#2A7A55" : "#C2CAD0"
                                  }`}
                                >
                                </span>
                                <cf-vstack
                                  gap="0"
                                  style="flex: 1; min-width: 0;"
                                >
                                  <cf-text
                                    block
                                    truncate
                                    style="font-weight: 600;"
                                  >
                                    {row.title || "(untitled session)"}
                                  </cf-text>
                                  <cf-text
                                    variant="caption"
                                    tone="muted"
                                    truncate
                                  >
                                    {captionOf(row)}
                                  </cf-text>
                                </cf-vstack>
                                <cf-button
                                  variant="secondary"
                                  size="sm"
                                  data-attach=""
                                  onClick={attachFromRow({
                                    attached,
                                    sourceId: row.sourceId,
                                    nativeSessionId: row.nativeSessionId,
                                    title: row.title,
                                  })}
                                >
                                  Attach
                                </cf-button>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        )
                        : (
                          <cf-text tone="muted" block>
                            {hasIndex
                              ? "Every session the connector knows is attached."
                              : "No session index linked, or the connector has not collected yet."}
                          </cf-text>
                        )}
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Start a session</cf-heading>
                      <cf-text variant="caption" tone="muted">
                        Your words go first; the topic's context and links
                        follow.
                      </cf-text>
                      <cf-field label="Prompt">
                        <cf-textarea
                          $value={spawnPrompt}
                          rows={3}
                          placeholder={defaultPrompt}
                        />
                      </cf-field>
                      <cf-hstack gap="2" align="end" style="flex-wrap: wrap;">
                        <cf-field label="Harness" style="flex: 1 1 12rem;">
                          <cf-select
                            data-harness=""
                            $value={spawnSource}
                            items={sourceOptions}
                          />
                        </cf-field>
                        <cf-field label="Checkout" style="flex: 1 1 14rem;">
                          <cf-select
                            $value={spawnRoot}
                            items={checkoutOptions}
                          />
                        </cf-field>
                        <cf-button
                          variant="ghost"
                          onClick={useDefaultPrompt({
                            spawnPrompt,
                            defaultPrompt,
                          })}
                        >
                          Add the topic's words
                        </cf-button>
                      </cf-hstack>
                      <cf-hstack gap="2" align="center">
                        <cf-button
                          variant="primary"
                          data-start=""
                          onClick={startSession}
                        >
                          Start
                        </cf-button>
                        <cf-text variant="caption" tone="muted">
                          {sourceOptions.length > 0
                            ? "Runs the first turn on this Mac through the connector; the start shows above as starting until the connector publishes the session, and can be dismissed if it never does."
                            : "No harness the connector runs here can start a session."}
                        </cf-text>
                      </cf-hstack>
                      {hasPrompt
                        ? (
                          <cf-vstack gap="2">
                            <cf-field label="Kickoff prompt, as it will be sent">
                              <cf-text
                                block
                                data-kickoff=""
                                style="font-family: ui-monospace, monospace; font-size: 0.82em; white-space: pre-wrap;"
                              >
                                {kickoff}
                              </cf-text>
                            </cf-field>
                            <cf-field label="Or run it yourself">
                              <cf-text
                                block
                                data-spawn-command=""
                                style="font-family: ui-monospace, monospace; font-size: 0.82em; white-space: pre-wrap; word-break: break-all;"
                              >
                                {spawnCommand}
                              </cf-text>
                            </cf-field>
                          </cf-vstack>
                        )
                        : null}
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </div>
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      attached,
      attachedSessions,
      pendingStarts: startingSessions,
      relatedSessions,
      recentSessions,
      spawnCommand,
      kickoff,
      spawnPrompt,
      spawnRoot,
      spawnSource,
      attach,
      detach,
      startSession,
    };
  },
);
