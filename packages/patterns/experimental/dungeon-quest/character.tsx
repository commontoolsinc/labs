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
  AddInventoryItemEvent,
  CharacterInput,
  CharacterOutput,
  DamageCharacterEvent,
  MoveCharacterEvent,
} from "./schemas.tsx";
import { DUNGEON_THEME } from "./theme.ts";

/** Durable dungeon character with a reference-addressed movement action. */
export default pattern<CharacterInput, CharacterOutput>(
  ({
    name,
    archetype,
    location,
    health,
    maxHealth,
    power,
    inventory,
  }) => {
    const moveTo = action(({ location: destination }: MoveCharacterEvent) => {
      const trimmed = (destination ?? "").trim();
      if (!trimmed) return;
      location.set(trimmed);
    });

    const takeDamage = action(({ amount }: DamageCharacterEvent) => {
      const damage = Math.max(1, Math.floor(amount ?? 2));
      health.set(Math.max(0, health.get() - damage));
    });

    const rest = action(() => health.set(maxHealth.get()));

    const addItem = action(({ item }: AddInventoryItemEvent) => {
      const trimmed = (item ?? "").trim();
      if (!trimmed) return;
      inventory.addUnique(trimmed);
    });

    const isDefeated = computed(() => health.get() <= 0);
    const isRested = computed(() => health.get() >= maxHealth.get());
    const hasInventory = computed(() => inventory.get().length > 0);

    return {
      [NAME]: computed(() => name),
      [UI]: (
        <cf-theme theme={DUNGEON_THEME}>
          <cf-screen>
            <cf-heading slot="header" level={2}>{name}</cf-heading>
            <cf-vstack gap="4" padding="4">
              <cf-card>
                <cf-vstack gap="4">
                  <cf-hstack gap="4" align="center">
                    <cf-avatar
                      name={name}
                      src="⚔️"
                      size="lg"
                      shape="square"
                    />
                    <cf-vstack gap="1">
                      <cf-text variant="heading-md">{name}</cf-text>
                      <cf-text tone="muted">{archetype}</cf-text>
                      <cf-badge color="accent">{location}</cf-badge>
                    </cf-vstack>
                  </cf-hstack>
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" justify="between" align="center">
                      <cf-text variant="heading-sm">Vitality</cf-text>
                      <cf-text variant="caption" tone="muted">
                        {health}/{maxHealth} HP · Power {power}
                      </cf-text>
                    </cf-hstack>
                    <cf-progress value={health} max={maxHealth} />
                    <cf-hstack gap="2" wrap>
                      <cf-button
                        size="sm"
                        variant="outline"
                        disabled={isDefeated}
                        onClick={() => takeDamage.send({ amount: 2 })}
                      >
                        Take 2 damage
                      </cf-button>
                      <cf-button
                        size="sm"
                        disabled={isRested}
                        onClick={rest}
                      >
                        Rest
                      </cf-button>
                    </cf-hstack>
                  </cf-vstack>
                </cf-vstack>
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
                    <cf-button
                      variant="outline"
                      onClick={() => moveTo.send({ location: "Sunken Gate" })}
                    >
                      Sunken Gate
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </cf-card>

              <cf-card>
                <cf-vstack gap="3">
                  <cf-heading level={3}>Pack</cf-heading>
                  {hasInventory
                    ? (
                      <cf-hstack gap="2" wrap>
                        {inventory.map((item) => <cf-chip>◈ {item}</cf-chip>)}
                      </cf-hstack>
                    )
                    : <cf-empty-state message="This pack is empty." />}
                  <cf-hstack gap="2" wrap>
                    <cf-button
                      size="sm"
                      variant="outline"
                      onClick={() => addItem.send({ item: "Healing draught" })}
                    >
                      Pack a healing draught
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
      health,
      maxHealth,
      power,
      inventory,
      moveTo,
      takeDamage,
      rest,
      addItem,
    };
  },
);
