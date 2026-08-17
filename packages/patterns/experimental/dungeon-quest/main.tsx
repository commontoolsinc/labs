/**
 * Composes the Sunken Gate adventure from durable character and quest pieces.
 * Shared state lives in the space while each entity keeps its own actions.
 */

import {
  action,
  computed,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
} from "commonfabric";

import Character from "./character.tsx";
import Quest from "./quest.tsx";
import type {
  AdventureInput,
  AdventureOutput,
  CreateCharacterEvent,
  CreateCharacterResult,
  JoinQuestEvent,
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

const enlistFromRoster = handler<void, {
  character: QuestCharacter;
  enlist: Stream<JoinQuestEvent>;
}>((_, { character, enlist }) => enlist.send({ character }));

export default pattern<AdventureInput, AdventureOutput>((
  { characters, questParticipants, questEvidence },
) => {
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
    const trimmedName = (name ?? "").trim() || "Unnamed adventurer";
    const character = Character({
      name: trimmedName,
      archetype: (archetype ?? "").trim() || "Adventurer",
      location: "Antechamber",
    });
    characters.push(character);
    return { character };
  });

  const createDraftCharacter = action(() => {
    const character = Character({
      name: "Unnamed adventurer",
      archetype: "Adventurer",
      location: "Antechamber",
    });
    characters.push(character);
  });
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

            <cf-tabs value="quest">
              <cf-tab-list>
                <cf-tab value="quest">Quest ledger</cf-tab>
                <cf-tab value="party">Party</cf-tab>
              </cf-tab-list>

              <cf-tab-panel value="quest">
                <cf-vstack gap="3" py="3">
                  <cf-hstack gap="2" justify="between" align="center">
                    <cf-text tone="muted">
                      Quest state is shared by everyone in this space.
                    </cf-text>
                    <cf-cell-link $cell={quest}>Open quest piece</cf-cell-link>
                  </cf-hstack>
                  <cf-render $cell={quest} variant="full" />
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="party">
                <cf-vstack gap="4" py="3">
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-heading level={3}>Create an adventurer</cf-heading>
                      <cf-text tone="muted">
                        Recruit a default adventurer here, then use the typed
                        action from the CLI to create named characters.
                      </cf-text>
                      <cf-hstack gap="3">
                        <cf-button onClick={createDraftCharacter}>
                          Create character
                        </cf-button>
                      </cf-hstack>
                    </cf-vstack>
                  </cf-card>

                  {hasCharacters
                    ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: "12px",
                        }}
                      >
                        {characters.map((character) => (
                          <cf-card>
                            <cf-vstack gap="3">
                              <cf-render $cell={character} variant="tile" />
                              <cf-hstack
                                gap="2"
                                justify="between"
                                align="center"
                              >
                                <cf-cell-link $cell={character}>
                                  Open character sheet
                                </cf-cell-link>
                                <cf-button
                                  size="sm"
                                  variant="outline"
                                  onClick={enlistFromRoster({
                                    character,
                                    enlist: quest.join,
                                  })}
                                >
                                  Join quest
                                </cf-button>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>
                        ))}
                      </div>
                    )
                    : (
                      <cf-empty-state message="No adventurers yet. Create the first character above." />
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
    recordQuestEvidence: quest.recordEvidence,
  };
});

export type {
  AdventureOutput,
  CharacterPiece,
  QuestCharacter,
  QuestEvidence,
  QuestObjectiveDefinition,
  QuestObjectiveProgress,
  QuestPiece,
} from "./schemas.tsx";
