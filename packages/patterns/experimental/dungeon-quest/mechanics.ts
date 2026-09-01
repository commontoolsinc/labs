import { Default, Writable } from "commonfabric";

import type {
  AdventureActionKind,
  AttemptAdventureActionResult,
  QuestCharacter,
  QuestEvidence,
} from "./schemas.tsx";

function evidenceKindFor(scene: AdventureActionKind): string {
  return scene === "assemble-party"
    ? "party.assembled"
    : scene === "open-sealed-door"
    ? "door.opened"
    : scene === "defeat-sentinel"
    ? "encounter.won"
    : "gate.opened";
}

export function resolveAdventureAction(
  scene: AdventureActionKind,
  questParticipants: Writable<QuestCharacter[] | Default<[]>>,
  questEvidence: Writable<QuestEvidence[] | Default<[]>>,
): AttemptAdventureActionResult {
  const existingEvidence = questEvidence.get();
  const party = [...questParticipants.get()];
  const evidenceKind = evidenceKindFor(scene);

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

export function formExpedition(
  occupants: readonly QuestCharacter[],
  questParticipants: Writable<QuestCharacter[] | Default<[]>>,
  questEvidence: Writable<QuestEvidence[] | Default<[]>>,
): AttemptAdventureActionResult {
  if (
    questEvidence.get().some((entry) => entry.kind === "party.assembled")
  ) {
    return { accepted: false, reason: "already-completed", actorCount: 0 };
  }
  if (occupants.length < 2) {
    return {
      accepted: false,
      reason: "insufficient-party",
      actorCount: occupants.length,
    };
  }
  occupants.forEach((character) => questParticipants.addUnique(character));
  questEvidence.push({
    kind: "party.assembled",
    actors: [...occupants],
    note:
      `${occupants.length} adventurers form an expedition in the Antechamber.`,
  });
  return { accepted: true, reason: "accepted", actorCount: occupants.length };
}
