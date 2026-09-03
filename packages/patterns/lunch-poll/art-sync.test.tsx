/**
 * Test: lunch-poll generated-art wiring — one host-gated editor plus explicit
 * keep-action persistence.
 *
 * Single-identity caveat (as main.test.tsx): this runtime's one identity IS
 * the host after joining, so the host path runs end-to-end: join → add an
 * option → the card opens the shared editor → GeneratedArt fetches the mocked
 * /api/ai/img generation → the host keeps it → the option carries `imageUrl`
 * and the stored <img> renders. Every other viewer renders that same stored
 * value without instantiating a generator for each option.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElement,
  findNodeByProp,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import CozyPoll, { type LunchProfile } from "./main.tsx";

// 1×1 transparent PNG, the mocked generation response body. The persisted
// value is its exact data URL: FetchBinary bytes → base64 re-encode is an
// identity round-trip on the same bytes, so the editor's keep button and this
// test send the same string. (Both plain literals: SES-mode module scope
// rejects computed top-level values like template joins.)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EXPECTED_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body: TINY_PNG_BASE64,
  },
];

export default pattern(() => {
  // Identity is a profile cell; claim the host's through the test seam.
  const host = Writable.of<LunchProfile>({ name: "Host" });
  const poll = CozyPoll({});

  const action_become_host = action(() => {
    poll.overrideViewer.send({ profile: host, name: "Host" });
  });

  const action_join_as_host = action(() => {
    poll.joinAs.send({});
  });

  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi Palace" });
  });

  const assert_option_added = assert(() =>
    poll.options.length === 1 && poll.options[0]?.title === "Sushi Palace"
  );

  const action_open_art_editor = action(() => {
    const button = findNodeByProp(
      poll[UI],
      "aria-label",
      "Generate art (host)",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_art_editor_opens = assert(() =>
    findNodeByProp(poll[UI], "data-art-editor", true) !== undefined
  );

  // Post-settle the host's client has generated: the cf-image overlay is in
  // the shared editor's rendered tree.
  const assert_generated_overlay_renders = assert(() =>
    findElement(poll[UI], "cf-image") !== undefined
  );

  const action_keep_art = action(() => {
    const button = findNodeByProp(
      poll[UI],
      "aria-label",
      "Keep this art (host)",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_image_persisted = assert(() =>
    readValue(poll.options[0]?.imageUrl) === EXPECTED_DATA_URL
  );

  const assert_stored_img_renders = assert(() =>
    findNodeByProp(poll[UI], "src", EXPECTED_DATA_URL) !== undefined
  );

  return {
    [TESTS]: [
      { action: action_become_host },
      { action: action_join_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      { action: action_open_art_editor },
      { assertion: assert_art_editor_opens },
      // Drives the mocked generation fetch to completion.
      { settle: true },
      { assertion: assert_generated_overlay_renders },
      { action: action_keep_art },
      { assertion: assert_image_persisted },
      // One more settle beat: the persisted URL flows back into the card as
      // `sourceUrl` and the stored-<img> branch re-renders.
      { settle: true },
      { assertion: assert_stored_img_renders },
    ],
    poll,
  };
});
