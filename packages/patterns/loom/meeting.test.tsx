/** Meeting binding confirms replays and preserves conflicting or unknown state. */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { BindMeetingResult } from "./schemas.tsx";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export default pattern(() => {
  const loom = Loom({});
  const oldRoot = Loom({
    title: "Established Loom",
    panels: [],
    presentation: { stagedPanels: [] },
    participants: {},
  });
  const reply = new Writable<BindMeetingResult>({ status: "invalid-key" });
  const bind = action(() => loom.bindMeeting.send({ key: KEY, reply }));
  const conflict = action(() => loom.bindMeeting.send({ key: OTHER, reply }));
  const bindOld = action(() => oldRoot.bindMeeting.send({ key: KEY }));
  const uppercase = action(() =>
    oldRoot.bindMeeting.send({ key: KEY.toUpperCase(), reply })
  );
  const whitespace = action(() =>
    oldRoot.bindMeeting.send({ key: `${KEY} `, reply })
  );
  const short = action(() => oldRoot.bindMeeting.send({ key: "abc", reply }));
  const newline = action(() =>
    oldRoot.bindMeeting.send({ key: `${KEY}\n`, reply })
  );
  const invalid = new Writable({ key: "malformed" });
  const invalidRoot = Loom({ meeting: invalid });
  const bindInvalid = action(() =>
    invalidRoot.bindMeeting.send({ key: KEY, reply })
  );
  const unknown = new Writable<{ key?: string; future: string }>({
    future: "keep",
  });
  const unknownRoot = Loom({ meeting: unknown });
  const bindUnknown = action(() =>
    unknownRoot.bindMeeting.send({ key: KEY, reply })
  );
  const future = new Writable({ key: KEY, future: "keep" });
  const futureRoot = Loom({ meeting: future });
  const replayFuture = action(() =>
    futureRoot.bindMeeting.send({ key: KEY, reply })
  );
  const conflictFuture = action(() =>
    futureRoot.bindMeeting.send({ key: OTHER, reply })
  );
  return {
    [TESTS]: [
      { assertion: assert(() => loom.meeting.key === undefined) },
      { assertion: assert(() => oldRoot.meeting.key === undefined) },
      { action: bind },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { assertion: assert(() => reply.get().status === "bound") },
      { action: bind },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { action: conflict },
      { assertion: assert(() => reply.get().status === "conflict") },
      { assertion: assert(() => loom.meeting.key === KEY) },
      { action: uppercase },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: whitespace },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: short },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { action: newline },
      { assertion: assert(() => reply.get().status === "invalid-key") },
      { assertion: assert(() => oldRoot.meeting.key === undefined) },
      { action: bindOld },
      { assertion: assert(() => oldRoot.meeting.key === KEY) },
      { action: bindInvalid },
      { assertion: assert(() => reply.get().status === "invalid-state") },
      { assertion: assert(() => invalid.get().key === "malformed") },
      { action: bindUnknown },
      { assertion: assert(() => reply.get().status === "invalid-state") },
      { assertion: assert(() => unknown.get().future === "keep") },
      { assertion: assert(() => unknown.get().key === undefined) },
      { action: replayFuture },
      { assertion: assert(() => reply.get().status === "already-bound") },
      { assertion: assert(() => future.get().future === "keep") },
      { action: conflictFuture },
      { assertion: assert(() => reply.get().status === "conflict") },
      { assertion: assert(() => future.get().key === KEY) },
      { assertion: assert(() => future.get().future === "keep") },
    ],
  };
});
