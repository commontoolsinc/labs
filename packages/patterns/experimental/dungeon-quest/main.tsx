/**
 * Composes the Sunken Gate adventure from durable character and quest pieces.
 * Shared state lives in the space while each entity keeps its own actions.
 */

import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

import Character from "./character.tsx";
import Location from "./location.tsx";
import { resolveAdventureAction } from "./mechanics.ts";
import Quest from "./quest.tsx";
import type {
  AdventureInput,
  AdventureOutput,
  AttemptAdventureActionEvent,
  AttemptAdventureActionResult,
  CharacterPiece,
  CreateCharacterEvent,
  CreateCharacterResult,
  QuestCharacter,
} from "./schemas.tsx";
import { DUNGEON_THEME } from "./theme.ts";

const SUNKEN_GATE_OBJECTIVES = [{
  key: "assemble-party",
  title: "Assemble a party",
  evidenceKind: "party.assembled",
  target: 1,
}, {
  key: "open-sealed-door",
  title: "Open the sealed door",
  evidenceKind: "door.opened",
  target: 1,
  requires: ["assemble-party"],
}, {
  key: "defeat-sentinel",
  title: "Defeat the sentinel",
  evidenceKind: "encounter.won",
  target: 1,
  requires: ["open-sealed-door"],
}, {
  key: "open-sunken-gate",
  title: "Open the Sunken Gate",
  evidenceKind: "gate.opened",
  target: 1,
  requires: ["defeat-sentinel"],
}];

const ARCHETYPE_OPTIONS = [
  { label: "Ranger · balanced explorer", value: "Ranger" },
  { label: "Guardian · resilient defender", value: "Guardian" },
  { label: "Mystic · powerful but fragile", value: "Mystic" },
];

function makeCharacter(
  rawName: string,
  rawArchetype?: string,
): CharacterPiece {
  const name = (rawName ?? "").trim() || "Unnamed adventurer";
  const archetype = (rawArchetype ?? "").trim() || "Adventurer";
  const maxHealth = archetype === "Guardian"
    ? 14
    : archetype === "Mystic"
    ? 8
    : 10;
  const power = archetype === "Mystic" ? 4 : archetype === "Ranger" ? 3 : 2;
  return Character({
    name,
    archetype,
    location: "Antechamber",
    health: maxHealth,
    maxHealth,
    power,
    inventory: archetype === "Ranger"
      ? ["Torch", "Rope"]
      : archetype === "Mystic"
      ? ["Runed focus", "Chalk"]
      : ["Torch", "Iron ration"],
  });
}

const enlistFromRoster = handler<void, {
  character: QuestCharacter;
  participants: Writable<QuestCharacter[] | Default<[]>>;
}>((_, { character, participants }) => {
  if (!(character?.name ?? "").trim()) return;
  participants.addUnique(character);
});

export default pattern<AdventureInput, AdventureOutput>((
  { characters, questParticipants, questEvidence },
) => {
  const newCharacterName = new Writable.perSession("");
  const newCharacterArchetype = new Writable.perSession("Ranger");
  const activeTab = new Writable.perSession("dungeon");
  const quest = Quest({
    title: "Open the Sunken Gate",
    summary:
      "Assemble a party, breach the sealed chambers, and open the ancient gate.",
    objectives: SUNKEN_GATE_OBJECTIVES,
    participants: questParticipants,
    evidence: questEvidence,
  });
  const locations = [
    Location({
      locationKey: "antechamber",
      characters,
      questParticipants,
      questEvidence,
    }),
    Location({
      locationKey: "moonlit-hall",
      characters,
      questParticipants,
      questEvidence,
    }),
    Location({
      locationKey: "gatehouse",
      characters,
      questParticipants,
      questEvidence,
    }),
    Location({
      locationKey: "sunken-gate",
      characters,
      questParticipants,
      questEvidence,
    }),
  ];

  const createCharacter = action<
    CreateCharacterEvent,
    CreateCharacterResult
  >(({ name, archetype }) => {
    const character = makeCharacter(name, archetype);
    characters.push(character);
    return { character };
  });
  const createFromDraft = action(() => {
    const trimmedName = (newCharacterName.get() ?? "").trim();
    if (!trimmedName) return;
    characters.push(
      makeCharacter(
        trimmedName,
        newCharacterArchetype.get() ?? "Ranger",
      ),
    );
    newCharacterName.set("");
  });

  const attemptAdventureAction = action<
    AttemptAdventureActionEvent,
    AttemptAdventureActionResult
  >(({ action: scene }) =>
    resolveAdventureAction(scene, questParticipants, questEvidence)
  );

  const hasCharacters = computed(() => characters.get().length > 0);

  return {
    [NAME]: "Dungeon Quest Prototype",
    [UI]: (
      <cf-theme theme={DUNGEON_THEME}>
        <cf-screen>
          <cf-heading slot="header" level={1}>The Sunken Gate</cf-heading>
          <cf-vstack gap="4" padding="4">
            <pre
              style={{
                margin: "0",
                padding: "16px",
                overflow: "hidden",
                color: "var(--cf-theme-color-primary)",
                background: "var(--cf-theme-color-background)",
                border: "1px solid var(--cf-theme-color-border)",
                borderRadius: "10px",
                fontFamily: "var(--cf-theme-font-mono)",
              }}
            >
{`      /\\
  ___/  \\___
 /  THE SUNKEN \\
|      GATE      |
 \\____/\\______/`}
            </pre>

            <cf-tabs $value={activeTab}>
              <cf-tab-list>
                <cf-tab value="dungeon">Dungeon</cf-tab>
                <cf-tab value="party">Party & characters</cf-tab>
                <cf-tab value="quest">Quest</cf-tab>
                <cf-tab value="log">Expedition log</cf-tab>
              </cf-tab-list>

              <cf-tab-panel value="dungeon">
                <cf-vstack gap="4" py="3">
                  <cf-card>
                    <cf-hstack gap="3" justify="between" align="center" wrap>
                      <cf-vstack gap="1">
                        <cf-heading level={2}>Enter the dungeon</cf-heading>
                        <cf-text tone="muted">
                          Every room is a durable piece. Visit one to see who is
                          there and perform its scene where it happens.
                        </cf-text>
                      </cf-vstack>
                      <cf-badge color="accent">
                        {quest.completedObjectiveCount}/4 scenes complete
                      </cf-badge>
                    </cf-hstack>
                  </cf-card>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: "12px",
                    }}
                  >
                    {locations.map((location) => (
                      <cf-card>
                        <cf-vstack gap="3">
                          <cf-render $cell={location} variant="tile" />
                          <cf-cell-link $cell={location}>
                            Visit {location.name}
                          </cf-cell-link>
                        </cf-vstack>
                      </cf-card>
                    ))}
                  </div>

                  <cf-text tone="muted">
                    Move a character from its sheet, then revisit a room to see
                    the shared presence update for every player.
                  </cf-text>
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="party">
                <cf-vstack gap="4" py="3">
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-heading level={3}>Recruit an adventurer</cf-heading>
                      <cf-text tone="muted">
                        Each character is its own durable piece with a sheet,
                        inventory, health, movement, and callable actions.
                      </cf-text>
                      <cf-vstack gap="3" aria-label="Create adventurer">
                        <cf-field label="Name" required>
                          <cf-input
                            aria-label="Character name"
                            placeholder="e.g. Nyx"
                            required
                            timingStrategy="immediate"
                            $value={newCharacterName}
                          />
                        </cf-field>
                        <cf-field label="Archetype">
                          <cf-select
                            aria-label="Character archetype"
                            items={ARCHETYPE_OPTIONS}
                            $value={newCharacterArchetype}
                          />
                        </cf-field>
                        <cf-hstack gap="2">
                          <cf-button
                            aria-label="Create named adventurer"
                            onClick={createFromDraft}
                          >
                            Create character
                          </cf-button>
                        </cf-hstack>
                      </cf-vstack>
                    </cf-vstack>
                  </cf-card>

                  {hasCharacters
                    ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(250px, 1fr))",
                          gap: "12px",
                        }}
                      >
                        {characters.map((character) => (
                          <cf-card>
                            <cf-vstack gap="3">
                              <cf-render $cell={character} variant="tile" />
                              <cf-text variant="caption" tone="muted">
                                {character.archetype} · {character.location}
                              </cf-text>
                              <cf-hstack
                                gap="2"
                                justify="between"
                                align="center"
                                wrap
                              >
                                <cf-cell-link $cell={character}>
                                  Open character sheet
                                </cf-cell-link>
                                <cf-button
                                  size="sm"
                                  variant="outline"
                                  onClick={enlistFromRoster({
                                    character,
                                    participants: questParticipants,
                                  })}
                                >
                                  Join expedition
                                </cf-button>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>
                        ))}
                      </div>
                    )
                    : (
                      <cf-empty-state message="No adventurers yet. Recruit the first character above." />
                    )}
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="quest">
                <cf-vstack gap="4" py="3">
                  <cf-card>
                    <cf-hstack gap="3" justify="between" align="center" wrap>
                      <cf-vstack gap="1">
                        <cf-heading level={2}>Expedition ledger</cf-heading>
                        <cf-text tone="muted">
                          Progress is derived from evidence recorded by actions
                          in the dungeon's rooms.
                        </cf-text>
                      </cf-vstack>
                      <cf-button
                        aria-label="Restart expedition"
                        variant="outline"
                        onClick={quest.reset}
                      >
                        {quest.status === "completed"
                          ? "Begin a new expedition"
                          : "Restart expedition"}
                      </cf-button>
                    </cf-hstack>
                  </cf-card>
                  <cf-cell-link $cell={quest}>Open quest piece</cf-cell-link>
                  <cf-render $cell={quest} variant="full" />
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="log">
                <cf-vstack gap="3" py="3">
                  <cf-heading level={2}>Shared expedition log</cf-heading>
                  {quest.evidence.length > 0
                    ? quest.evidence.map((entry) => (
                      <cf-card>
                        <cf-vstack gap="2">
                          <cf-hstack gap="2" justify="between" align="center">
                            <cf-text variant="heading-sm">{entry.kind}</cf-text>
                            <cf-badge color="accent">
                              {entry.actors.length} actor(s)
                            </cf-badge>
                          </cf-hstack>
                          <cf-text>{entry.note}</cf-text>
                          <cf-text variant="caption" tone="muted">
                            {entry.actors.map((actor) => actor.name).join(", ")}
                          </cf-text>
                        </cf-vstack>
                      </cf-card>
                    ))
                    : (
                      <cf-empty-state message="No scenes resolved yet. Assemble a party to begin." />
                    )}
                </cf-vstack>
              </cf-tab-panel>
            </cf-tabs>
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    ),
    characters,
    locations,
    quest,
    createCharacter,
    enlistCharacter: quest.join,
    attemptAdventureAction,
    restartQuest: quest.reset,
    recordQuestEvidence: quest.recordEvidence,
  };
});

export type {
  AdventureActionKind,
  AdventureActionReason,
  AdventureOutput,
  AttemptAdventureActionEvent,
  AttemptAdventureActionResult,
  CharacterPiece,
  DungeonLocationKey,
  LocationPiece,
  QuestCharacter,
  QuestEvidence,
  QuestObjectiveDefinition,
  QuestObjectiveProgress,
  QuestPiece,
} from "./schemas.tsx";
