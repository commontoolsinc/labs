/**
 * Pattern test for the topic workbench: the topic header reads through the
 * narrow view, sessions come off the connector index newest first with
 * deleted rows dropped, a session naming the topic is offered as related,
 * attach is idempotent and joins the live row, detach removes it, and the
 * spawn command composes from the picked checkout and prompt.
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
import Workbench, {
  type Attachment,
  type SessionIndexView,
  type TopicView,
} from "./main.tsx";

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
  const wb = Workbench({ topic, sessions: index, attached });

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

  return {
    [NAME]: "Topic workbench test",
    [UI]: wb[UI],
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
    ],
  };
});
