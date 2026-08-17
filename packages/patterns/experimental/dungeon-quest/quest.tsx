import {
  action,
  CHIP_UI,
  computed,
  type Default,
  equals,
  handler,
  NAME,
  pattern,
  TILE_UI,
  UI,
  type Writable,
} from "commonfabric";

import type {
  JoinQuestEvent,
  QuestCharacter,
  QuestEvidence,
  QuestInput,
  QuestObjectiveDefinition,
  QuestObjectiveProgress,
  QuestOutput,
  QuestStatus,
  RecordQuestEvidenceEvent,
  RecordQuestEvidenceResult,
} from "./schemas.tsx";
import { DUNGEON_THEME } from "./theme.ts";

const reportObjective = handler<void, {
  objective: QuestObjectiveDefinition;
  participants: Writable<QuestCharacter[] | Default<[]>>;
  evidence: Writable<QuestEvidence[] | Default<[]>>;
}>((_, { objective, participants, evidence }) => {
  const actors = [...participants.get()];
  if (actors.length === 0) return;
  evidence.push({
    kind: objective.evidenceKind,
    actors,
    note: `Reported from the quest ledger: ${objective.title}`,
  });
});

/**
 * Collaborative quest ledger whose progress derives from participant-linked
 * evidence records.
 */
export default pattern<QuestInput, QuestOutput>(
  ({ title, summary, objectives, participants, evidence }) => {
    const progress = computed(() =>
      objectives.reduce<QuestObjectiveProgress[]>((rows, objective) => {
        const target = Math.max(1, objective.target ?? 1);
        const matchingEvidence = evidence.get().filter((entry) =>
          entry.kind === objective.evidenceKind
        );
        const dependenciesComplete = (objective.requires ?? []).every((key) =>
          rows.some((row) => row.key === key && row.status === "completed")
        );
        const contributors = matchingEvidence.reduce<
          QuestObjectiveProgress["contributors"]
        >(
          (all, entry) =>
            entry.actors.reduce(
              (actors, actor) =>
                actors.some((candidate) => equals(candidate, actor))
                  ? actors
                  : [...actors, actor],
              all,
            ),
          [],
        );
        const current = matchingEvidence.length;
        const status = dependenciesComplete
          ? current >= target ? "completed" as const : "active" as const
          : "locked" as const;
        return [...rows, {
          ...objective,
          current,
          target,
          status,
          contributors,
        }];
      }, [])
    );

    const completedObjectiveCount = computed(() =>
      progress.filter((objective) => objective.status === "completed")
        .length
    );
    const hasParticipants = computed(() => participants.get().length > 0);

    const status = computed<QuestStatus>(() => {
      const rows = progress;
      if (rows.length > 0 && rows.every((row) => row.status === "completed")) {
        return "completed";
      }
      return participants.get().length > 0 ? "active" : "available";
    });

    const join = action(({ character }: JoinQuestEvent) => {
      if (!(character?.name ?? "").trim()) return;
      participants.addUnique(character);
    });

    const recordEvidence = action<
      RecordQuestEvidenceEvent,
      RecordQuestEvidenceResult
    >(({ kind, actors, note }) => {
      const trimmedKind = (kind ?? "").trim();
      if (!trimmedKind) {
        return { accepted: false, reason: "empty-kind" };
      }
      if (
        !objectives.some((objective) => objective.evidenceKind === trimmedKind)
      ) {
        return { accepted: false, reason: "unknown-kind" };
      }
      if ((actors ?? []).length === 0) {
        return { accepted: false, reason: "no-actors" };
      }
      if (
        !(actors ?? []).every((actor) =>
          participants.get().some((participant) => equals(participant, actor))
        )
      ) {
        return { accepted: false, reason: "unlisted-actor" };
      }
      evidence.push({
        kind: trimmedKind,
        actors,
        note: (note ?? "").trim(),
      });
      return { accepted: true, reason: "accepted" };
    });

    return {
      [NAME]: title,
      [UI]: (
        <cf-theme theme={DUNGEON_THEME}>
          <cf-vstack gap="4">
            <cf-card>
              <cf-vstack gap="3">
                <cf-hstack gap="3" justify="between" align="center">
                  <cf-vstack gap="1">
                    <cf-heading level={2}>{title}</cf-heading>
                    <cf-text tone="muted">{summary}</cf-text>
                  </cf-vstack>
                  <cf-badge
                    color={status === "completed" ? "accent" : "primary"}
                  >
                    {status}
                  </cf-badge>
                </cf-hstack>
                <cf-progress
                  value={completedObjectiveCount}
                  max={objectives.length}
                />
                <cf-text variant="caption" tone="muted">
                  {completedObjectiveCount}/{objectives.length} objectives
                </cf-text>
              </cf-vstack>
            </cf-card>

            <cf-vstack gap="2">
              <cf-heading level={3}>Objectives</cf-heading>
              {progress.map((objective) => (
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" justify="between" align="center">
                      <cf-text variant="heading-sm">{objective.title}</cf-text>
                      <cf-badge
                        color={objective.status === "completed"
                          ? "accent"
                          : objective.status === "active"
                          ? "primary"
                          : "neutral"}
                      >
                        {objective.status}
                      </cf-badge>
                    </cf-hstack>
                    <cf-progress
                      value={objective.current}
                      max={objective.target}
                    />
                    <cf-hstack gap="2" justify="between" align="center">
                      <cf-text variant="caption" tone="muted">
                        Evidence: {objective.evidenceKind}
                      </cf-text>
                      <cf-button
                        size="sm"
                        aria-label={`Mark ${objective.title} complete`}
                        disabled={objective.status !== "active" ||
                          !hasParticipants}
                        onClick={reportObjective({
                          objective,
                          participants,
                          evidence,
                        })}
                      >
                        Mark complete
                      </cf-button>
                    </cf-hstack>
                  </cf-vstack>
                </cf-card>
              ))}
            </cf-vstack>

            <cf-card>
              <cf-vstack gap="3">
                <cf-heading level={3}>Party</cf-heading>
                {hasParticipants
                  ? (
                    <cf-hstack gap="3" wrap>
                      {participants.map((participant) => (
                        <cf-hstack gap="2" align="center">
                          <cf-avatar
                            name={participant.name}
                            src="🛡️"
                            size="sm"
                          />
                          <cf-vstack gap="0">
                            <cf-text>{participant.name}</cf-text>
                            <cf-text variant="caption" tone="muted">
                              {participant.archetype} · {participant.location}
                            </cf-text>
                          </cf-vstack>
                        </cf-hstack>
                      ))}
                    </cf-hstack>
                  )
                  : (
                    <cf-empty-state message="No adventurers have joined this quest yet." />
                  )}
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-theme>
      ),
      [CHIP_UI]: (
        <cf-chip>
          ⌁ {title} · {completedObjectiveCount}/{objectives.length}
        </cf-chip>
      ),
      [TILE_UI]: (
        <cf-theme theme={DUNGEON_THEME}>
          <cf-card>
            <cf-vstack gap="2">
              <cf-text variant="heading-sm">{title}</cf-text>
              <cf-progress
                value={completedObjectiveCount}
                max={objectives.length}
              />
              <cf-text variant="caption" tone="muted">
                {completedObjectiveCount}/{objectives.length} objectives ·{" "}
                {status}
              </cf-text>
            </cf-vstack>
          </cf-card>
        </cf-theme>
      ),
      title,
      summary,
      status,
      objectives,
      progress,
      participants,
      evidence,
      completedObjectiveCount,
      join,
      recordEvidence,
    };
  },
);
