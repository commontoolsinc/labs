/**
 * Pattern test for the topic workbench: the topic header reads through the
 * narrow view, sessions come off the connector index newest first with
 * deleted rows dropped, a session naming the topic is offered as related,
 * attach is idempotent and joins the live row, detach removes it, the
 * spawn command composes from the picked checkout and prompt, a start
 * sends the connector a `start` command and attaches the session it named,
 * the rail's own buttons attach and detach a row and add the topic's words
 * to the prompt, and a verb call without both ids is refused.
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
  hasExactText,
  hasText,
  propsOf,
} from "../test/vnode-helpers.ts";
import Workbench, {
  type Attachment,
  type CommandValue,
  type SessionIndexView,
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
    ],
  });
  // Plain rows stand in for the connector's linked child cells: the pattern
  // reads the same shallow fields either way.
  const index = new Writable<SessionIndexView>({
    schema: "commonfabric.agent-connector.session-index",
    ownerDid: "did:key:owner",
    sources: [
      { id: "codex", driver: "codex-app-server" },
      { id: "claude", driver: "claude-agent-sdk" },
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
  const wb = Workbench({ topic, sessions: index, attached, commands });

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
    wb.spawnCommand.startsWith(
      "cd '/w/labs' && claude 'Work on topic #7, it'\\''s time.",
    )
  );

  // A start sends one `start` command for the Claude source, named after the
  // topic and carrying the kickoff, and attaches the session it minted.
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
  const assert_start_attached = assert(() =>
    wb.attachedSessions.length === 2 &&
    wb.attachedSessions[1]?.nativeSessionId ===
      firstCommand(commands.get())?.nativeSessionId &&
    wb.attachedSessions[1]?.title === "topic #7: Workbench topic" &&
    wb.attachedSessions[1]?.sourceId === "claude"
  );

  // The rail's buttons write the same record the verbs do: Attach on a recent
  // row attaches it and takes it out of the rail, Detach puts it back.
  const action_click_attach = action(() => {
    clickInRow(wb[UI], "something unrelated", "Attach");
  });
  const assert_clicked_attached = assert(() =>
    wb.attachedSessions.length === 3 &&
    wb.attachedSessions[2]?.nativeSessionId === "bbb" &&
    wb.attachedSessions[2]?.title === "something unrelated" &&
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
      { assertion: assert_start_attached },
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
