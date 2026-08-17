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

  const action_take_damage_from_ui = action(() => {
    const button = findElementByText(
      character[UI],
      "cf-button",
      "Take 2 damage",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_pack_item_from_ui = action(() => {
    const button = findElementByText(
      character[UI],
      "cf-button",
      "Pack a healing draught",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_rest_from_ui = action(() => {
    const button = findElementByText(character[UI], "cf-button", "Rest");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_initial_sheet = assert(() =>
    character.location === "Antechamber" &&
    character.health === 10 &&
    character.maxHealth === 10 &&
    character.power === 2 &&
    character.inventory?.length === 0 &&
    hasText(character[UI], "Alara") &&
    hasText(character[UI], "Travel") &&
    hasText(character[UI], "Vitality")
  );

  const assert_moved_from_sheet = assert(() =>
    character.location === "Moonlit Hall" &&
    hasText(character[UI], "Moonlit Hall")
  );

  const assert_damaged_and_packed = assert(() =>
    character.health === 8 &&
    character.inventory?.length === 1 &&
    character.inventory?.[0] === "Healing draught"
  );

  const assert_rested = assert(() => character.health === 10);

  return {
    [TESTS]: [
      { render: character[UI] },
      { assertion: assert_initial_sheet },
      { action: action_move_from_ui },
      { render: character[UI] },
      { assertion: assert_moved_from_sheet },
      { action: action_take_damage_from_ui },
      { action: action_pack_item_from_ui },
      { assertion: assert_damaged_and_packed },
      { action: action_rest_from_ui },
      { assertion: assert_rested },
    ],
    subject: character,
  };
});
