import {
  action,
  CHIP_UI,
  computed,
  NAME,
  pattern,
  TILE_UI,
  UI,
} from "commonfabric";

import { formExpedition, resolveAdventureAction } from "./mechanics.ts";
import type {
  AdventureActionKind,
  AttemptAdventureActionResult,
  DungeonLocationKey,
  LocationInput,
  LocationOutput,
  QuestObjectiveStatus,
} from "./schemas.tsx";
import { DUNGEON_THEME } from "./theme.ts";

function locationName(locationKey: DungeonLocationKey): string {
  return locationKey === "antechamber"
    ? "Antechamber"
    : locationKey === "moonlit-hall"
    ? "Moonlit Hall"
    : locationKey === "gatehouse"
    ? "Gatehouse"
    : "Sunken Gate";
}

function locationDescription(locationKey: DungeonLocationKey): string {
  return locationKey === "antechamber"
    ? "A torchlit refuge where strangers become an expedition."
    : locationKey === "moonlit-hall"
    ? "Cold moonlight reveals a sealed door cut with silver runes."
    : locationKey === "gatehouse"
    ? "An iron sentinel guards the stair descending beneath the keep."
    : "Four ancient seals hold back the black water beyond the gate.";
}

function locationMap(locationKey: DungeonLocationKey): string {
  return locationKey === "antechamber"
    ? `[ camp ]───╴`
    : locationKey === "moonlit-hall"
    ? `╶──[ moon ]──╴`
    : locationKey === "gatehouse"
    ? `╶──[ guard ]──╴`
    : `╶──[ SUNKEN GATE ]`;
}

function sceneFor(locationKey: DungeonLocationKey): AdventureActionKind {
  return locationKey === "antechamber"
    ? "assemble-party"
    : locationKey === "moonlit-hall"
    ? "open-sealed-door"
    : locationKey === "gatehouse"
    ? "defeat-sentinel"
    : "open-sunken-gate";
}

function actionLabel(locationKey: DungeonLocationKey): string {
  return locationKey === "antechamber"
    ? "Form an expedition"
    : locationKey === "moonlit-hall"
    ? "Open the sealed door"
    : locationKey === "gatehouse"
    ? "Challenge the sentinel"
    : "Turn the gate seals";
}

function requirement(locationKey: DungeonLocationKey): string {
  return locationKey === "antechamber"
    ? "Bring at least two characters here. This action enlists everyone present."
    : locationKey === "moonlit-hall"
    ? "One expedition member must be present after the party assembles."
    : locationKey === "gatehouse"
    ? "Two expedition members must be present after the sealed door opens."
    : "Two expedition members must be present after the sentinel falls.";
}

/** A durable, navigable dungeon room with live presence and a local mechanic. */
export default pattern<LocationInput, LocationOutput>((
  { locationKey, characters, questParticipants, questEvidence },
) => {
  const name = locationName(locationKey);
  const description = locationDescription(locationKey);
  const map = locationMap(locationKey);
  const scene = sceneFor(locationKey);
  const label = actionLabel(locationKey);
  const occupants = computed(() =>
    characters.filter((character) => character.location === name)
  );
  const occupantCount = computed(() => occupants.length);
  const objectiveStatus = computed((): QuestObjectiveStatus => {
    const evidence = questEvidence.get();
    const completedKind = scene === "assemble-party"
      ? "party.assembled"
      : scene === "open-sealed-door"
      ? "door.opened"
      : scene === "defeat-sentinel"
      ? "encounter.won"
      : "gate.opened";
    if (evidence.some((entry) => entry.kind === completedKind)) {
      return "completed";
    }
    const prerequisiteKind = scene === "open-sealed-door"
      ? "party.assembled"
      : scene === "defeat-sentinel"
      ? "door.opened"
      : scene === "open-sunken-gate"
      ? "encounter.won"
      : "";
    return prerequisiteKind &&
        !evidence.some((entry) => entry.kind === prerequisiteKind)
      ? "locked"
      : "active";
  });
  const requiredOccupants = locationKey === "moonlit-hall" ? 1 : 2;
  const actionDisabled = computed(() =>
    objectiveStatus !== "active" || occupantCount < requiredOccupants
  );

  const performAction = action<void, AttemptAdventureActionResult>(() => {
    if (locationKey === "antechamber") {
      return formExpedition(
        occupants,
        questParticipants,
        questEvidence,
      );
    }
    return resolveAdventureAction(scene, questParticipants, questEvidence);
  });

  return {
    [NAME]: computed(() => name),
    [UI]: (
      <cf-theme theme={DUNGEON_THEME}>
        <cf-screen>
          <cf-heading slot="header" level={1}>{name}</cf-heading>
          <cf-vstack gap="4" padding="4">
            <cf-card>
              <cf-vstack gap="3">
                <pre
                  style={{
                    margin: "0",
                    color: "var(--cf-theme-color-primary)",
                    fontFamily: "var(--cf-theme-font-mono)",
                  }}
                >
                  {map}
                </pre>
                <cf-hstack gap="2" justify="between" align="center" wrap>
                  <cf-vstack gap="1">
                    <cf-heading level={2}>{name}</cf-heading>
                    <cf-text tone="muted">{description}</cf-text>
                  </cf-vstack>
                  <cf-badge color="accent">{objectiveStatus}</cf-badge>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="3">
                <cf-hstack gap="2" justify="between" align="center">
                  <cf-heading level={2}>Present in this room</cf-heading>
                  <cf-badge>{occupantCount}</cf-badge>
                </cf-hstack>
                {occupantCount > 0
                  ? occupants.map((character) => (
                    <cf-hstack gap="3" justify="between" align="center" wrap>
                      <cf-hstack gap="2" align="center">
                        <cf-avatar
                          name={character.name}
                          src="⚔️"
                          size="sm"
                          shape="square"
                        />
                        <cf-vstack gap="0">
                          <cf-text variant="heading-sm">
                            {character.name}
                          </cf-text>
                          <cf-text variant="caption" tone="muted">
                            {character.archetype}
                          </cf-text>
                        </cf-vstack>
                      </cf-hstack>
                      <cf-cell-link $cell={character}>
                        Open character sheet
                      </cf-cell-link>
                    </cf-hstack>
                  ))
                  : (
                    <cf-empty-state message="No characters are here. Move one here from its character sheet." />
                  )}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="3">
                <cf-heading level={2}>Room action</cf-heading>
                <cf-text tone="muted">{requirement(locationKey)}</cf-text>
                <cf-button
                  aria-label={`Perform ${scene} in ${name}`}
                  disabled={actionDisabled}
                  onClick={performAction}
                >
                  {label}
                </cf-button>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    ),
    [CHIP_UI]: <cf-chip>⌂ {name} · {occupantCount} present</cf-chip>,
    [TILE_UI]: (
      <cf-theme theme={DUNGEON_THEME}>
        <cf-card>
          <cf-vstack gap="2">
            <cf-hstack gap="2" justify="between" align="center">
              <cf-text variant="heading-sm">{name}</cf-text>
              <cf-badge>{objectiveStatus}</cf-badge>
            </cf-hstack>
            <cf-text variant="caption" tone="muted">{description}</cf-text>
            <cf-text variant="caption">{occupantCount} present</cf-text>
          </cf-vstack>
        </cf-card>
      </cf-theme>
    ),
    locationKey,
    name,
    description,
    occupants,
    occupantCount,
    objectiveStatus,
    performAction,
  };
});
