/**
 * Test Pattern: Google task-pattern auth availability
 *
 * Instantiates the Gmail task patterns whose auth handoff changed on this
 * branch. Empty auth keeps API calls inactive while exercising their initial
 * missing-auth state.
 */
import { assert, pattern, Writable } from "commonfabric";
import type { Auth } from "../core/gmail-importer.tsx";
import EmailNotes from "./email-notes.tsx";
import ExpectResponseFollowup from "./expect-response-followup.tsx";
import EmailTaskEngine from "../../experimental/email-task-engine.tsx";

function emptyAuth() {
  return new Writable<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: { email: "", name: "", picture: "" },
  });
}

export default pattern(() => {
  const notes = EmailNotes({});
  const followup = ExpectResponseFollowup({});
  const taskEngine = EmailTaskEngine({ overrideAuth: emptyAuth() });

  const assert_notes_start_empty = assert(() =>
    notes.noteCount === 0 && notes.notes.length === 0
  );

  const assert_followups_start_empty = assert(() =>
    followup.threadCount === 0 &&
    followup.dueCount === 0 &&
    followup.threads.length === 0
  );

  const assert_task_engine_starts_empty = assert(() =>
    taskEngine.taskCount === 0 &&
    taskEngine.taskEmails.length === 0 &&
    taskEngine.analyses.length === 0
  );

  return {
    tests: [
      { assertion: assert_notes_start_empty },
      { assertion: assert_followups_start_empty },
      { assertion: assert_task_engine_starts_empty },
    ],
    notes,
    followup,
    taskEngine,
  };
});
