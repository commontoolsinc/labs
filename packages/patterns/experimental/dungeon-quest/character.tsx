import {
  action,
  CHIP_UI,
  computed,
  NAME,
  pattern,
  TILE_UI,
  UI,
} from "commonfabric";

import type {
  CharacterInput,
  CharacterOutput,
  MoveCharacterEvent,
} from "./schemas.tsx";
import { DUNGEON_THEME } from "./theme.ts";

/** Durable dungeon character with a reference-addressed movement action. */
export default pattern<CharacterInput, CharacterOutput>(
  ({ name, archetype, location }) => {
    const moveTo = action(({ location: destination }: MoveCharacterEvent) => {
      const trimmed = (destination ?? "").trim();
      if (!trimmed) return;
      location.set(trimmed);
    });

    return {
      [NAME]: computed(() => name),
      [UI]: (
        <cf-theme theme={DUNGEON_THEME}>
          <cf-screen>
            <cf-heading slot="header" level={2}>{name}</cf-heading>
            <cf-vstack gap="4" padding="4">
              <cf-card>
                <cf-hstack gap="4" align="center">
                  <cf-avatar name={name} src="⚔️" size="lg" shape="square" />
                  <cf-vstack gap="1">
                    <cf-text variant="heading-md">{name}</cf-text>
                    <cf-text tone="muted">{archetype}</cf-text>
                    <cf-badge color="accent">{location}</cf-badge>
                  </cf-vstack>
                </cf-hstack>
              </cf-card>

              <cf-card>
                <cf-vstack gap="3">
                  <cf-heading level={3}>Travel</cf-heading>
                  <cf-text tone="muted">
                    Movement belongs to this character piece. Open this sheet
                    from the party roster whenever you want to move them.
                  </cf-text>
                  <cf-hstack gap="2" wrap>
                    <cf-button
                      variant="outline"
                      onClick={() => moveTo.send({ location: "Antechamber" })}
                    >
                      Antechamber
                    </cf-button>
                    <cf-button
                      variant="outline"
                      onClick={() => moveTo.send({ location: "Moonlit Hall" })}
                    >
                      Moonlit Hall
                    </cf-button>
                    <cf-button
                      variant="outline"
                      onClick={() => moveTo.send({ location: "Gatehouse" })}
                    >
                      Gatehouse
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      [CHIP_UI]: <cf-chip>⚔ {name} · {location}</cf-chip>,
      [TILE_UI]: (
        <cf-theme theme={DUNGEON_THEME}>
          <cf-card>
            <cf-vstack gap="2">
              <cf-hstack gap="2" align="center">
                <cf-avatar name={name} src="⚔️" size="sm" shape="square" />
                <cf-vstack gap="0">
                  <cf-text variant="heading-sm">{name}</cf-text>
                  <cf-text variant="caption" tone="muted">{archetype}</cf-text>
                </cf-vstack>
              </cf-hstack>
              <cf-badge color="accent">{location}</cf-badge>
            </cf-vstack>
          </cf-card>
        </cf-theme>
      ),
      name,
      archetype,
      location,
      moveTo,
    };
  },
);
