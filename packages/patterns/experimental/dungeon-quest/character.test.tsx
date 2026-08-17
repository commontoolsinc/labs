import { action, assert, pattern, TESTS, UI } from "commonfabric";

import {
  findElementByText,
  hasText,
  propsOf,
} from "../../test/vnode-helpers.ts";
import Character from "./character.tsx";

export default pattern(() => {
  const character = Character({
    name: "Alara",
    archetype: "Ranger",
    location: "Antechamber",
  });

  const action_move_from_ui = action(() => {
    const button = findElementByText(
      character[UI],
      "cf-button",
      "Moonlit Hall",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_initial_sheet = assert(() =>
    character.location === "Antechamber" &&
    hasText(character[UI], "Alara") &&
    hasText(character[UI], "Travel")
  );

  const assert_moved_from_sheet = assert(() =>
    character.location === "Moonlit Hall" &&
    hasText(character[UI], "Moonlit Hall")
  );

  return {
    [TESTS]: [
      { render: character[UI] },
      { assertion: assert_initial_sheet },
      { action: action_move_from_ui },
      { render: character[UI] },
      { assertion: assert_moved_from_sheet },
    ],
    subject: character,
  };
});
