/**
 * Test: Collaborative Note
 *
 * Verifies the example's shared editor contract: the note is writable, the
 * room is forwarded to co-presence, and profile setup is visible while the
 * viewer's profile wishes are unresolved in the headless test runtime.
 *
 * Run: deno task cf test packages/patterns/collaborative-note/main.test.tsx
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElement,
  findNodeById,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import CollaborativeNote, {
  normalizePresenceParticipantName,
} from "./main.tsx";

const ROOM = "collaborative_note_room_01";

export default pattern(() => {
  const note = Writable.of("Starting point");
  const subject = CollaborativeNote({ note, presenceRoom: ROOM });

  const assert_editor_contract = assert(() => {
    const editorProps = propsOf(findElement(subject[UI], "cf-code-editor"));
    return editorProps !== undefined &&
      readValue(editorProps.collaborative) === true &&
      readValue(editorProps.presenceRoom) === ROOM &&
      readValue(editorProps.participantName) === "" &&
      readValue(editorProps.mode) === "prose" &&
      readValue(editorProps["$value"]) === "Starting point";
  });
  const assert_profile_setup_visible = assert(() =>
    findNodeById(subject[UI], "collaborative-note-profile-setup") !== undefined
  );
  const assert_profile_name_is_safe_for_presence = assert(() =>
    normalizePresenceParticipantName("  Ada\u0000\u0085 Lovelace  ") ===
      "Ada Lovelace" &&
    normalizePresenceParticipantName("a".repeat(81)) === "a".repeat(80) &&
    normalizePresenceParticipantName("😀".repeat(65)) === "😀".repeat(64) &&
    normalizePresenceParticipantName("\ud800") === ""
  );
  const action_edit = action(() => note.set("Edited together"));
  const assert_edit_visible = assert(() => {
    const editorProps = propsOf(findElement(subject[UI], "cf-code-editor"));
    return readValue(editorProps?.["$value"]) === "Edited together";
  });

  return {
    [TESTS]: [
      { assertion: assert_editor_contract },
      { assertion: assert_profile_setup_visible },
      { assertion: assert_profile_name_is_safe_for_presence },
      { action: action_edit },
      { assertion: assert_edit_visible },
    ],
    subject,
  };
});
