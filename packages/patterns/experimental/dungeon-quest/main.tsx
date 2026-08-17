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
import Quest from "./quest.tsx";
import type {
  AdventureActionKind,
  AdventureInput,
  AdventureOutput,
  AttemptAdventureActionEvent,
  AttemptAdventureActionResult,
  CharacterPiece,
  CreateCharacterEvent,
  CreateCharacterResult,
  QuestCharacter,
  QuestEvidence,
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

function resolveAdventureAction(
  scene: AdventureActionKind,
  questParticipants: Writable<QuestCharacter[] | Default<[]>>,
  questEvidence: Writable<QuestEvidence[] | Default<[]>>,
): AttemptAdventureActionResult {
  const existingEvidence = questEvidence.get();
  const party = [...questParticipants.get()];
  const evidenceKind = scene === "assemble-party"
    ? "party.assembled"
    : scene === "open-sealed-door"
    ? "door.opened"
    : scene === "defeat-sentinel"
    ? "encounter.won"
    : "gate.opened";

  if (existingEvidence.some((entry) => entry.kind === evidenceKind)) {
    return { accepted: false, reason: "already-completed", actorCount: 0 };
  }

  const prerequisiteKind = scene === "open-sealed-door"
    ? "party.assembled"
    : scene === "defeat-sentinel"
    ? "door.opened"
    : scene === "open-sunken-gate"
    ? "encounter.won"
    : "";
  if (
    prerequisiteKind &&
    !existingEvidence.some((entry) => entry.kind === prerequisiteKind)
  ) {
    return {
      accepted: false,
      reason: "prerequisite-incomplete",
      actorCount: 0,
    };
  }

  if (scene === "assemble-party") {
    if (party.length < 2) {
      return {
        accepted: false,
        reason: "insufficient-party",
        actorCount: party.length,
      };
    }
    questEvidence.push({
      kind: evidenceKind,
      actors: party,
      note: `${party.length} adventurers set out together.`,
    });
    return { accepted: true, reason: "accepted", actorCount: party.length };
  }

  const requiredLocation = scene === "open-sealed-door"
    ? "Moonlit Hall"
    : scene === "defeat-sentinel"
    ? "Gatehouse"
    : "Sunken Gate";
  const actors = party.filter((character) =>
    character.location === requiredLocation
  );
  const requiredActors = scene === "open-sealed-door" ? 1 : 2;
  if (party.length < requiredActors) {
    return {
      accepted: false,
      reason: "insufficient-party",
      actorCount: party.length,
    };
  }
  if (actors.length < requiredActors) {
    return {
      accepted: false,
      reason: "wrong-location",
      actorCount: actors.length,
    };
  }

  const note = scene === "open-sealed-door"
    ? `${actors[0].name} opens the sealed door from the Moonlit Hall.`
    : scene === "defeat-sentinel"
    ? `${actors.length} adventurers defeat the gatehouse sentinel.`
    : `${actors.length} adventurers turn the seals of the Sunken Gate.`;
  questEvidence.push({ kind: evidenceKind, actors, note });
  return { accepted: true, reason: "accepted", actorCount: actors.length };
}

const enlistFromRoster = handler<void, {
  character: QuestCharacter;
  participants: Writable<QuestCharacter[] | Default<[]>>;
}>((_, { character, participants }) => {
  if (!(character?.name ?? "").trim()) return;
  participants.addUnique(character);
});

const createFromDraft = handler<void, {
  name: Writable<string>;
  archetype: Writable<string>;
  characters: Writable<CharacterPiece[] | Default<[]>>;
}>((_, { name, archetype, characters }) => {
  const trimmedName = (name.get() ?? "").trim();
  if (!trimmedName) return;
  characters.push(makeCharacter(trimmedName, archetype.get() ?? "Ranger"));
  name.set("");
});

const attemptScene = handler<void, {
  scene: AdventureActionKind;
  participants: Writable<QuestCharacter[] | Default<[]>>;
  evidence: Writable<QuestEvidence[] | Default<[]>>;
}>((_, { scene, participants, evidence }) => {
  resolveAdventureAction(scene, participants, evidence);
});

export default pattern<AdventureInput, AdventureOutput>((
  { characters, questParticipants, questEvidence },
) => {
  const newCharacterName = new Writable.perSession("");
  const newCharacterArchetype = new Writable.perSession("Ranger");
  const activeTab = new Writable.perSession("adventure");
  const quest = Quest({
    title: "Open the Sunken Gate",
    summary:
      "Assemble a party, breach the sealed chambers, and open the ancient gate.",
    objectives: SUNKEN_GATE_OBJECTIVES,
    participants: questParticipants,
    evidence: questEvidence,
  });

  const createCharacter = action<
    CreateCharacterEvent,
    CreateCharacterResult
  >(({ name, archetype }) => {
    const character = makeCharacter(name, archetype);
    characters.push(character);
    return { character };
  });

  const attemptAdventureAction = action<
    AttemptAdventureActionEvent,
    AttemptAdventureActionResult
  >(({ action: scene }) =>
    resolveAdventureAction(scene, questParticipants, questEvidence)
  );

  const hasCharacters = computed(() => characters.get().length > 0);
  const partyCount = computed(() => questParticipants.get().length);
  const moonlitHallCount = computed(() =>
    questParticipants.get().filter((character) =>
      character.location === "Moonlit Hall"
    ).length
  );
  const gatehouseCount = computed(() =>
    questParticipants.get().filter((character) =>
      character.location === "Gatehouse"
    ).length
  );
  const sunkenGateCount = computed(() =>
    questParticipants.get().filter((character) =>
      character.location === "Sunken Gate"
    ).length
  );

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
                <cf-tab value="adventure">Adventure</cf-tab>
                <cf-tab value="party">Party & characters</cf-tab>
                <cf-tab value="log">Expedition log</cf-tab>
              </cf-tab-list>

              <cf-tab-panel value="adventure">
                <cf-vstack gap="4" py="3">
                  <cf-card>
                    <cf-hstack gap="3" justify="between" align="center" wrap>
                      <cf-vstack gap="1">
                        <cf-heading level={2}>Expedition controls</cf-heading>
                        <cf-text tone="muted">
                          Enlist characters, move them from their sheets, then
                          resolve each shared scene in order.
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

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: "12px",
                    }}
                  >
                    <cf-card>
                      <cf-vstack gap="3">
                        <cf-hstack gap="2" justify="between" align="center">
                          <cf-text variant="heading-sm">1 · Assemble</cf-text>
                          <cf-badge>{quest.progress[0].status}</cf-badge>
                        </cf-hstack>
                        <cf-text tone="muted">
                          At least two enlisted characters must set out
                          together. Party: {partyCount}/2.
                        </cf-text>
                        <cf-button
                          aria-label="Attempt assemble party"
                          disabled={quest.progress[0].status !== "active" ||
                            partyCount < 2}
                          onClick={attemptScene({
                            scene: "assemble-party",
                            participants: questParticipants,
                            evidence: questEvidence,
                          })}
                        >
                          Set out together
                        </cf-button>
                      </cf-vstack>
                    </cf-card>

                    <cf-card>
                      <cf-vstack gap="3">
                        <cf-hstack gap="2" justify="between" align="center">
                          <cf-text variant="heading-sm">2 · The door</cf-text>
                          <cf-badge>{quest.progress[1].status}</cf-badge>
                        </cf-hstack>
                        <cf-text tone="muted">
                          Move one enlisted character to Moonlit Hall. Present:
                          {" "}
                          {moonlitHallCount}/1.
                        </cf-text>
                        <cf-button
                          aria-label="Attempt open sealed door"
                          disabled={quest.progress[1].status !== "active" ||
                            moonlitHallCount < 1}
                          onClick={attemptScene({
                            scene: "open-sealed-door",
                            participants: questParticipants,
                            evidence: questEvidence,
                          })}
                        >
                          Open the sealed door
                        </cf-button>
                      </cf-vstack>
                    </cf-card>

                    <cf-card>
                      <cf-vstack gap="3">
                        <cf-hstack gap="2" justify="between" align="center">
                          <cf-text variant="heading-sm">3 · Sentinel</cf-text>
                          <cf-badge>{quest.progress[2].status}</cf-badge>
                        </cf-hstack>
                        <cf-text tone="muted">
                          Move two enlisted characters to the Gatehouse.
                          Present: {gatehouseCount}/2.
                        </cf-text>
                        <cf-button
                          aria-label="Attempt defeat sentinel"
                          disabled={quest.progress[2].status !== "active" ||
                            gatehouseCount < 2}
                          onClick={attemptScene({
                            scene: "defeat-sentinel",
                            participants: questParticipants,
                            evidence: questEvidence,
                          })}
                        >
                          Challenge the sentinel
                        </cf-button>
                      </cf-vstack>
                    </cf-card>

                    <cf-card>
                      <cf-vstack gap="3">
                        <cf-hstack gap="2" justify="between" align="center">
                          <cf-text variant="heading-sm">4 · The gate</cf-text>
                          <cf-badge>{quest.progress[3].status}</cf-badge>
                        </cf-hstack>
                        <cf-text tone="muted">
                          Move two enlisted characters to the Sunken Gate.
                          Present: {sunkenGateCount}/2.
                        </cf-text>
                        <cf-button
                          aria-label="Attempt open Sunken Gate"
                          disabled={quest.progress[3].status !== "active" ||
                            sunkenGateCount < 2}
                          onClick={attemptScene({
                            scene: "open-sunken-gate",
                            participants: questParticipants,
                            evidence: questEvidence,
                          })}
                        >
                          Open the Sunken Gate
                        </cf-button>
                      </cf-vstack>
                    </cf-card>
                  </div>

                  <cf-hstack gap="2" justify="between" align="center" wrap>
                    <cf-text tone="muted">
                      Quest state is shared by every browser and CLI agent in
                      this space.
                    </cf-text>
                    <cf-cell-link $cell={quest}>Open quest ledger</cf-cell-link>
                  </cf-hstack>
                  <cf-render $cell={quest} variant="full" />
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
                            onClick={createFromDraft({
                              name: newCharacterName,
                              archetype: newCharacterArchetype,
                              characters,
                            })}
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
  QuestCharacter,
  QuestEvidence,
  QuestObjectiveDefinition,
  QuestObjectiveProgress,
  QuestPiece,
} from "./schemas.tsx";
