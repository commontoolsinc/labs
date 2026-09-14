/**
 * Pattern test for the topic workbench: the topic header reads through the
 * narrow view, sessions come off the connector index newest first with
 * deleted rows dropped, a session naming the topic is offered as related,
 * attach is idempotent and joins the live row, detach removes it, the
 * spawn command composes from the picked checkout and prompt, a start
 * sends the connector a `start` command and records it as pending until the
 * index carries the session it named (a start with no queue stays pending
 * and can be dismissed), the rail's own buttons attach and detach a row and
 * add the topic's words to the prompt, and a verb call without both ids is
 * refused.
 */
import {
  action,
  assert,
  Default,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  findNode,
  findNodeByProp,
  hasExactText,
  hasText,
  propsOf,
  propValue,
} from "../test/vnode-helpers.ts";
import Workbench, {
  type Attachment,
  type CommandValue,
  type PendingStart,
  type SessionIndexView,
  type StartableSourcesView,
  type TopicView,
} from "./main.tsx";

type ClickStream = { send: (event: Record<string, never>) => void };

const isButton = (label: string) => (candidate: unknown): boolean =>
  propsOf(candidate)?.onClick !== undefined &&
  hasExactText(candidate, label);

/** The innermost node the predicate accepts: the row itself rather than
 * every container that also carries the row's text. */
const innermost = (
  node: unknown,
  accept: (node: unknown) => boolean,
): unknown => {
  for (const child of childNodes(node)) {
    const hit = innermost(child, accept);
    if (hit !== undefined) return hit;
  }
  return accept(node) ? node : undefined;
};

const send = (node: unknown): void => {
  const onClick = propsOf(node)?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as ClickStream).send({});
  }
};

/** Click the button labelled `label` in the row whose text carries `rowText`. */
const clickInRow = (root: unknown, rowText: string, label: string): void => {
  const row = innermost(
    root,
    (candidate) =>
      hasText(candidate, rowText) &&
      findNode(candidate, isButton(label)) !== undefined,
  );
  send(findNode(row, isButton(label)));
};

/** Click the one button labelled `label`. */
const click = (root: unknown, label: string): void =>
  send(findNode(root, isButton(label)));

/** The first queued command, decoded; `null` when the queue is empty. */
// deno-lint-ignore no-explicit-any
const firstCommand = (queued: readonly CommandValue[]): any =>
  JSON.parse(queued[0] ?? "null");

export default pattern(() => {
  const topic = new Writable<TopicView>({
    title: "Workbench topic",
    shortName: "7",
    body: "The living document, which a session starts from.",
    commentCount: 2,
    lastActivityAt: 1_700_000_000_000,
    links: [
      { kind: "web", url: "https://example.com/page", label: "a page" },
      { kind: "pr", url: "https://github.com/o/r/pull/1", label: "#1" },
      {
        kind: "web",
        url: "https://example.com/gone",
        label: "retracted",
        removedAt: 5,
      },
      // Stored before the topic's write guard: rendered as text, kept out of
      // the kickoff.
      { kind: "pr", url: "javascript:alert(1)", label: "legacy" },
    ],
  });
  // Plain rows stand in for the connector's linked child cells: the pattern
  // reads the same shallow fields either way.
  const index = new Writable<SessionIndexView & StartableSourcesView>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
    // Codex is configured but its driver cannot start a session; an ACP
    // source and Claude can, and Claude is listed first however the
    // connector orders them.
    sources: [
      { id: "codex", driver: "codex-app-server", capabilities: {} },
      { id: "acp-lab", driver: "acp", capabilities: { startSession: true } },
      {
        id: "claude",
        driver: "claude-agent-sdk",
        capabilities: { startSession: true },
      },
    ],
    sessions: [
      {
        sourceId: "claude",
        nativeSessionId: "aaa",
        title: "topic #7: Workbench topic",
        cwd: "/w/labs",
        gitRepo: null,
        gitBranch: "main",
        gitWorktreeRoot: null,
        updatedAt: "2026-09-08T10:00:00.000Z",
        active: true,
        archived: false,
        syncStatus: "complete",
      },
      {
        sourceId: "claude",
        nativeSessionId: "bbb",
        title: "something unrelated",
        cwd: "/w/other",
        gitRepo: null,
        gitBranch: "feature",
        gitWorktreeRoot: null,
        updatedAt: "2026-09-08T11:00:00.000Z",
        active: false,
        archived: false,
        syncStatus: "complete",
      },
      {
        sourceId: "claude",
        nativeSessionId: "ccc",
        title: "deleted upstream",
        cwd: null,
        gitRepo: null,
        gitBranch: null,
        gitWorktreeRoot: null,
        updatedAt: "2026-09-08T12:00:00.000Z",
        active: null,
        archived: null,
        syncStatus: "deleted",
      },
    ],
    checkouts: [{ root: "/w/labs", branch: "main" }],
  });
  const attached = new Writable<Attachment[] | Default<[]>>([]);
  const commands = new Writable<CommandValue[] | Default<[]>>([]);
  const pendingStarts = new Writable<PendingStart[] | Default<[]>>([]);
  const wb = Workbench({
    topic,
    sessions: index,
    attached,
    commands,
    pendingStarts,
  });
  // A workbench whose host has bound no queue yet: a start reaches nothing.
  const noQueuePending = new Writable<PendingStart[] | Default<[]>>([]);
  const noQueue = Workbench({
    topic,
    sessions: index,
    attached: new Writable<Attachment[] | Default<[]>>([]),
    pendingStarts: noQueuePending,
  });

  const assert_header = assert(() =>
    wb[NAME] === "Workbench: Workbench topic" &&
    wb.attachedSessions.length === 0 &&
    // Newest first, and the deleted row is dropped.
    wb.recentSessions.length === 2 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb" &&
    wb.recentSessions[1]?.nativeSessionId === "aaa" &&
    wb.recentSessions[1]?.active === true &&
    // The session whose title names the topic is offered as related.
    wb.relatedSessions.length === 1 &&
    wb.relatedSessions[0]?.nativeSessionId === "aaa"
  );

  // Only a source whose driver can start is offered as a harness, Claude
  // first, and a stored link that is not http(s) renders as text with no
  // anchor.
  const assert_harnesses_and_links = assert(() =>
    JSON.stringify(
        propValue(findNodeByProp(wb[UI], "data-harness", ""), "items"),
      ) === JSON.stringify([
        { label: "claude  (claude-agent-sdk)", value: "claude" },
        { label: "acp-lab  (acp)", value: "acp-lab" },
      ]) &&
    findNode(
        wb[UI],
        (node) => propValue(node, "href") === "javascript:alert(1)",
      ) === undefined &&
    hasText(wb[UI], "legacy")
  );

  const action_attach = action(() => {
    wb.attach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_attached = assert(() =>
    wb.attachedSessions.length === 1 &&
    // Joined with the live row: the title comes from the index, not the
    // attach call, which named none.
    wb.attachedSessions[0]?.title === "topic #7: Workbench topic" &&
    wb.attachedSessions[0]?.gitBranch === "main" &&
    wb.attachedSessions[0]?.attached === true &&
    wb.relatedSessions.length === 0 &&
    wb.recentSessions.length === 1 &&
    wb.recentSessions[0]?.nativeSessionId === "bbb"
  );

  const action_attach_again = action(() => {
    wb.attach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_attach_idempotent = assert(() =>
    wb.attachedSessions.length === 1
  );

  // An attachment the index no longer carries still shows from its own record.
  const action_attach_unknown = action(() => {
    wb.attach.send({
      sourceId: "codex",
      nativeSessionId: "zzz",
      title: "a session the index forgot",
    });
  });
  const assert_unknown_kept = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions[1]?.title === "a session the index forgot" &&
    wb.attachedSessions[1]?.gitBranch === ""
  );

  const action_detach = action(() => {
    wb.detach.send({ sourceId: "claude", nativeSessionId: "aaa" });
  });
  const assert_detached = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.attachedSessions[0]?.nativeSessionId === "zzz" &&
    wb.recentSessions.length === 2
  );

  const action_compose_spawn = action(() => {
    wb.spawnRoot.set("/w/labs");
    wb.spawnPrompt.set("Work on topic #7, it's time.");
  });
  const assert_spawn_command = assert(() =>
    wb.kickoff.startsWith(
      'Work on topic #7, it\'s time.\n\nContext:\n- Topic #7, "Workbench topic". Its living document begins: The living document, which a session starts from.',
    ) &&
    wb.kickoff.includes("Links:\n- #1: https://github.com/o/r/pull/1") &&
    !wb.kickoff.includes("javascript:") &&
    wb.spawnCommand.startsWith(
      "cd '/w/labs' && claude 'Work on topic #7, it'\\''s time.",
    )
  );

  // A start sends one `start` command for the Claude source, named after the
  // topic and carrying the kickoff, and records the session it minted as
  // pending: nothing attaches until the index carries the session.
  const action_start = action(() => {
    wb.startSession.send();
  });
  const assert_start_command = assert(() =>
    commands.get().length === 1 &&
    firstCommand(commands.get())?.schema ===
      "commonfabric.agent-connector.command" &&
    firstCommand(commands.get())?.ownerDid === "did:key:owner" &&
    firstCommand(commands.get())?.type === "start" &&
    firstCommand(commands.get())?.sourceId === "claude" &&
    /^[0-9a-f-]{36}$/.test(
      firstCommand(commands.get())?.nativeSessionId ?? "",
    ) &&
    firstCommand(commands.get())?.payload?.cwd === "/w/labs" &&
    firstCommand(commands.get())?.payload?.title ===
      "topic #7: Workbench topic" &&
    firstCommand(commands.get())?.payload?.text === wb.kickoff
  );
  const assert_start_pending = assert(() =>
    wb.attachedSessions.length === 1 &&
    wb.pendingStarts.length === 1 &&
    wb.pendingStarts[0]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.pendingStarts[0]?.commandId === firstCommand(commands.get())?.id &&
    wb.pendingStarts[0]?.title === "topic #7: Workbench topic" &&
    hasText(wb[UI], "Starting · 1")
  );

  // The connector publishes the session: the start is confirmed and counts
  // as attached, joined with its live row.
  const action_confirm_start = action(() => {
    const started = firstCommand(commands.get())?.nativeSessionId ?? "";
    const current = index.get();
    index.set({
      ...current,
      sessions: [
        ...current.sessions,
        {
          sourceId: "claude",
          nativeSessionId: started,
          title: "topic #7: Workbench topic",
          cwd: "/w/labs",
          gitRepo: null,
          gitBranch: "main",
          gitWorktreeRoot: null,
          updatedAt: "2026-09-08T13:00:00.000Z",
          active: true,
          archived: false,
          syncStatus: "complete",
        },
      ],
    });
  });
  const assert_start_attached = assert(() =>
    wb.pendingStarts.length === 0 &&
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions[1]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.attachedSessions[1]?.title === "topic #7: Workbench topic" &&
    wb.attachedSessions[1]?.sourceId === "claude" &&
    wb.attachedSessions[1]?.gitBranch === "main" &&
    wb.recentSessions.every((row) =>
      row.nativeSessionId !== firstCommand(commands.get())?.nativeSessionId
    )
  );

  // A confirmed start stays attached when the connector later marks the
  // session deleted: the row shows from its own record, as a manually
  // attached session does, and does not fall back to starting.
  const action_delete_started = action(() => {
    const started = firstCommand(commands.get())?.nativeSessionId ?? "";
    const current = index.get();
    index.set({
      ...current,
      sessions: current.sessions.map((s) =>
        s && s.nativeSessionId === started
          ? { ...s, syncStatus: "deleted" as const }
          : s
      ),
    });
  });
  const assert_deleted_still_attached = assert(() =>
    wb.pendingStarts.length === 0 &&
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions.some((row) =>
      row.nativeSessionId === firstCommand(commands.get())?.nativeSessionId &&
      row.gitBranch === ""
    )
  );

  // With no queue bound, a start records nothing as attached: it stays
  // pending, and Dismiss clears it.
  const action_start_without_queue = action(() => {
    noQueue.spawnPrompt.set("Start without a queue.");
    noQueue.startSession.send();
  });
  const assert_start_without_queue_pending = assert(() =>
    noQueue.attachedSessions.length === 0 &&
    noQueue.pendingStarts.length === 1 &&
    noQueuePending.get().length === 1
  );
  const action_dismiss_start = action(() => {
    clickInRow(noQueue[UI], "topic #7: Workbench topic", "Dismiss");
  });
  const assert_start_dismissed = assert(() =>
    noQueue.pendingStarts.length === 0 && noQueuePending.get().length === 0
  );

  // A start through the Codex source sends nothing: its driver cannot start
  // a session, so the picker never offered it and the handler refuses it.
  const action_start_codex = action(() => {
    wb.spawnSource.set("codex");
    wb.startSession.send();
  });
  const assert_codex_start_refused = assert(() =>
    commands.get().length === 1 && wb.attachedSessions.length === 2
  );

  // The rail's buttons write the same record the verbs do: Attach on a recent
  // row attaches it and takes it out of the rail, Detach puts it back.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something unrelated", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.attachedSessions.length === 3 &&
    wb.attachedSessions.some((row) =>
      row.nativeSessionId === "bbb" && row.title === "something unrelated"
    ) &&
    wb.recentSessions.every((row) => row.nativeSessionId !== "bbb")
  );
  const action_click_detach = action(() => {
    clickInRow(wb[UI], "something unrelated", "Detach");
  });
  const assert_clicked_detached = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.recentSessions.some((row) => row.nativeSessionId === "bbb")
  );

  // "Add the topic's words" appends the default sentence to what the person
  // typed rather than replacing it.
  const action_click_topic_words = action(() => {
    click(wb[UI], "Add the topic's words");
  });
  const assert_topic_words_appended = assert(() =>
    wb.kickoff.startsWith(
      'Work on topic #7, it\'s time.\n\nWork on topic #7, "Workbench topic".\n\nContext:',
    )
  );

  // A verb call without both ids is refused and changes nothing.
  const action_attach_without_ids = action(() => {
    wb.attach.send({ sourceId: "", nativeSessionId: "" });
  });
  const assert_attach_refused = assert(() => wb.attachedSessions.length === 2);

  return {
    [NAME]: "Topic workbench test",
    [UI]: wb[UI],
    // The refused attach above throws inside the verb, which the runner
    // reports as a runtime error; exactly one is expected.
    expectRuntimeErrors: 1,
    [TESTS]: [
      { assertion: assert_header },
      { assertion: assert_harnesses_and_links },
      { render: wb[UI] },
      { action: action_attach },
      { assertion: assert_attached },
      { action: action_attach_again },
      { assertion: assert_attach_idempotent },
      { action: action_attach_unknown },
      { assertion: assert_unknown_kept },
      { render: wb[UI] },
      { action: action_detach },
      { assertion: assert_detached },
      { action: action_compose_spawn },
      { assertion: assert_spawn_command },
      { action: action_start },
      { assertion: assert_start_command },
      { assertion: assert_start_pending },
      { action: action_confirm_start },
      { assertion: assert_start_attached },
      { action: action_delete_started },
      { assertion: assert_deleted_still_attached },
      { action: action_start_without_queue },
      { assertion: assert_start_without_queue_pending },
      { render: noQueue[UI] },
      { action: action_dismiss_start },
      { assertion: assert_start_dismissed },
      { action: action_start_codex },
      { assertion: assert_codex_start_refused },
      { action: action_click_attach },
      { assertion: assert_clicked_attached },
      { action: action_click_detach },
      { assertion: assert_clicked_detached },
      { action: action_click_topic_words },
      { assertion: assert_topic_words_appended },
      { action: action_attach_without_ids },
      { assertion: assert_attach_refused },
    ],
  };
});
