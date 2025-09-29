/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type VoteValue = "yes" | "maybe" | "no";

interface ParticipantInput {
  id?: string;
  name?: string;
}

interface ParticipantDefinition {
  id: string;
  name: string;
}

interface SlotInput {
  id?: string;
  label?: string;
}

interface SlotDefinition {
  id: string;
  label: string;
}

type VoteRecord = Record<string, Record<string, VoteValue>>;

interface VoteEvent {
  participant?: string;
  slot?: string;
  vote?: string;
}

interface ProposeSlotEvent {
  id?: string;
  label?: string;
}

interface VoteChange {
  participantId: string;
  participantName: string;
  slotId: string;
  slotLabel: string;
  vote: VoteValue;
  yesCount: number;
  maybeCount: number;
  noCount: number;
}

interface SlotUpdate {
  slotId: string;
  label: string;
  mode: "added";
}

interface SlotVoteSummary {
  slotId: string;
  slotLabel: string;
  yes: number;
  maybe: number;
  no: number;
  pending: string[];
}

interface ConsensusSnapshot {
  slotId: string | null;
  slotLabel: string;
  yes: number;
  maybe: number;
  no: number;
  outstanding: number;
  outstandingNames: string[];
  status: "locked" | "pending";
  participantCount: number;
}

interface MeetingSchedulerArgs {
  participants: Default<
    ParticipantInput[],
    typeof defaultParticipants
  >;
  slots: Default<SlotInput[], typeof defaultSlots>;
}

const defaultParticipants: ParticipantDefinition[] = [
  { id: "alex-rivera", name: "Alex Rivera" },
  { id: "blair-chen", name: "Blair Chen" },
  { id: "casey-morgan", name: "Casey Morgan" },
];

const defaultSlots: SlotDefinition[] = [
  { id: "tuesday-0900", label: "Tuesday 09:00" },
  { id: "tuesday-1400", label: "Tuesday 14:00" },
  { id: "wednesday-1000", label: "Wednesday 10:00" },
];

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const ensureUnique = (value: string, used: Set<string>): string => {
  let candidate = value;
  if (candidate.length === 0) {
    candidate = "slot";
  }
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const normalizeParticipantName = (
  value: unknown,
  fallback: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeParticipants = (
  value: unknown,
): ParticipantDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultParticipants);
  }
  const used = new Set<string>();
  const sanitized: ParticipantDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as ParticipantInput | string | undefined;
    const fallback = defaultParticipants[index] ?? defaultParticipants[0];
    const name = typeof entry === "string"
      ? normalizeParticipantName(entry, fallback.name)
      : normalizeParticipantName(entry?.name, fallback.name);
    const baseIdSource = typeof entry === "string"
      ? entry
      : typeof entry?.id === "string" && entry.id.trim().length > 0
      ? entry.id
      : name;
    const baseId = slugify(baseIdSource);
    const id = ensureUnique(
      baseId.length > 0 ? baseId : slugify(fallback.id),
      used,
    );
    sanitized.push({ id, name });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultParticipants);
  }
  return sanitized;
};

const normalizeSlotLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeSlots = (value: unknown): SlotDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultSlots);
  }
  const used = new Set<string>();
  const sanitized: SlotDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as SlotInput | string | undefined;
    const fallback = defaultSlots[index] ?? defaultSlots[0];
    const label = typeof entry === "string"
      ? normalizeSlotLabel(entry, fallback.label)
      : normalizeSlotLabel(entry?.label, fallback.label);
    if (label.length === 0) {
      continue;
    }
    const baseIdSource = typeof entry === "string"
      ? entry
      : typeof entry?.id === "string" && entry.id.trim().length > 0
      ? entry.id
      : label;
    const baseId = slugify(baseIdSource);
    const id = ensureUnique(
      baseId.length > 0 ? baseId : slugify(fallback.id),
      used,
    );
    sanitized.push({ id, label });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultSlots);
  }
  return sanitized;
};

const normalizeVoteValue = (value: unknown): VoteValue | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "yes" || trimmed === "maybe" || trimmed === "no") {
    return trimmed;
  }
  return null;
};

const resolveParticipantId = (
  participants: readonly ParticipantDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = participants.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byName = participants.find((entry) =>
    entry.name.toLowerCase() === normalized
  );
  return byName?.id ?? null;
};

const resolveSlotId = (
  slots: readonly SlotDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = slots.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byLabel = slots.find((entry) =>
    entry.label.toLowerCase() === normalized
  );
  return byLabel?.id ?? null;
};

const normalizeVoteState = (
  value: unknown,
  slots: readonly SlotDefinition[],
  participants: readonly ParticipantDefinition[],
): VoteRecord => {
  const participantIds = new Set(participants.map((entry) => entry.id));
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const sanitized: VoteRecord = {};
  for (const slot of slots) {
    const raw = source[slot.id];
    const slotVotes: Record<string, VoteValue> = {};
    if (raw && typeof raw === "object") {
      const entries = raw as Record<string, unknown>;
      for (const [participantId, voteValue] of Object.entries(entries)) {
        if (!participantIds.has(participantId)) continue;
        const vote = normalizeVoteValue(voteValue);
        if (!vote) continue;
        slotVotes[participantId] = vote;
      }
    }
    sanitized[slot.id] = slotVotes;
  }
  return sanitized;
};

const recordHistoryEntry = (history: Cell<string[]>, entry: string): void => {
  const current = history.get();
  const list = Array.isArray(current) ? [...current, entry] : [entry];
  history.set(list.slice(-12));
};

const countVoteType = (
  votes: Record<string, VoteValue>,
  kind: VoteValue,
): number => {
  let total = 0;
  for (const value of Object.values(votes)) {
    if (value === kind) total += 1;
  }
  return total;
};

const buildVoteTallies = (
  slots: readonly SlotDefinition[],
  participants: readonly ParticipantDefinition[],
  votes: VoteRecord,
): SlotVoteSummary[] => {
  const summaries: SlotVoteSummary[] = [];
  for (const slot of slots) {
    const slotVotes = votes[slot.id] ?? {};
    const yes = countVoteType(slotVotes, "yes");
    const maybe = countVoteType(slotVotes, "maybe");
    const no = countVoteType(slotVotes, "no");
    const pending: string[] = [];
    for (const participant of participants) {
      if (!slotVotes[participant.id]) {
        pending.push(participant.name);
      }
    }
    summaries.push({
      slotId: slot.id,
      slotLabel: slot.label,
      yes,
      maybe,
      no,
      pending,
    });
  }
  return summaries;
};

const computeConsensus = (
  tallies: readonly SlotVoteSummary[],
  participants: readonly ParticipantDefinition[],
): ConsensusSnapshot => {
  if (!Array.isArray(tallies) || tallies.length === 0) {
    const names = participants.map((entry) => entry.name);
    return {
      slotId: null,
      slotLabel: "No slots proposed",
      yes: 0,
      maybe: 0,
      no: 0,
      outstanding: names.length,
      outstandingNames: names,
      status: "pending",
      participantCount: names.length,
    };
  }
  let best = tallies[0];
  for (let index = 1; index < tallies.length; index++) {
    const candidate = tallies[index];
    if (candidate.yes > best.yes) {
      best = candidate;
      continue;
    }
    if (candidate.yes === best.yes) {
      if (candidate.maybe > best.maybe) {
        best = candidate;
        continue;
      }
      if (
        candidate.maybe === best.maybe &&
        candidate.slotLabel.localeCompare(best.slotLabel) < 0
      ) {
        best = candidate;
      }
    }
  }
  const outstanding = best.pending.length;
  const status = outstanding === 0 && best.yes >= best.no
    ? "locked"
    : "pending";
  return {
    slotId: best.slotId,
    slotLabel: best.slotLabel,
    yes: best.yes,
    maybe: best.maybe,
    no: best.no,
    outstanding,
    outstandingNames: [...best.pending],
    status,
    participantCount: participants.length,
  };
};

const castVote = handler(
  (
    event: VoteEvent | undefined,
    context: {
      participants: Cell<ParticipantInput[]>;
      slots: Cell<SlotInput[]>;
      votes: Cell<VoteRecord>;
      history: Cell<string[]>;
      latestVote: Cell<VoteChange | null>;
    },
  ) => {
    const participantList = sanitizeParticipants(context.participants.get());
    const slotList = sanitizeSlots(context.slots.get());
    if (participantList.length === 0 || slotList.length === 0) {
      return;
    }
    const vote = normalizeVoteValue(event?.vote);
    if (!vote) return;
    const participantId = resolveParticipantId(
      participantList,
      event?.participant,
    );
    if (!participantId) return;
    const slotId = resolveSlotId(slotList, event?.slot);
    if (!slotId) return;

    const participant = participantList.find((entry) =>
      entry.id === participantId
    );
    const slot = slotList.find((entry) => entry.id === slotId);
    if (!participant || !slot) return;

    const sanitizedState = normalizeVoteState(
      context.votes.get(),
      slotList,
      participantList,
    );
    const slotVotes = { ...sanitizedState[slotId] };
    if (slotVotes[participantId] === vote) {
      return;
    }
    slotVotes[participantId] = vote;
    const nextState: VoteRecord = { ...sanitizedState, [slotId]: slotVotes };
    context.votes.set(nextState);

    const yesCount = countVoteType(slotVotes, "yes");
    const maybeCount = countVoteType(slotVotes, "maybe");
    const noCount = countVoteType(slotVotes, "no");

    recordHistoryEntry(
      context.history,
      `${participant.name} voted ${vote} for ${slot.label}`,
    );

    const change: VoteChange = {
      participantId,
      participantName: participant.name,
      slotId,
      slotLabel: slot.label,
      vote,
      yesCount,
      maybeCount,
      noCount,
    };
    context.latestVote.set(change);
  },
);

const proposeSlot = handler(
  (
    event: ProposeSlotEvent | undefined,
    context: {
      participants: Cell<ParticipantInput[]>;
      slots: Cell<SlotInput[]>;
      votes: Cell<VoteRecord>;
      history: Cell<string[]>;
      latestSlotUpdate: Cell<SlotUpdate | null>;
    },
  ) => {
    const slotList = sanitizeSlots(context.slots.get());
    const label = normalizeSlotLabel(event?.label ?? event?.id, "");
    if (label.length === 0) {
      return;
    }
    const baseIdSource =
      typeof event?.id === "string" && event.id.trim().length > 0
        ? event.id
        : label;
    const baseId = slugify(baseIdSource);
    const exists = slotList.some((entry) =>
      entry.id === baseId || entry.label.toLowerCase() === label.toLowerCase()
    );
    if (exists) {
      return;
    }
    const used = new Set(slotList.map((entry) => entry.id));
    const slotId = ensureUnique(
      baseId.length > 0 ? baseId : slugify(label),
      used,
    );
    const nextSlots = [...slotList, { id: slotId, label }];
    context.slots.set(nextSlots.map((entry) => ({ ...entry })));

    const participants = sanitizeParticipants(context.participants.get());
    const votes = normalizeVoteState(
      context.votes.get(),
      nextSlots,
      participants,
    );
    context.votes.set(votes);

    recordHistoryEntry(context.history, `Proposed slot ${label}`);
    context.latestSlotUpdate.set({ slotId, label, mode: "added" });
  },
);

/**
 * Meeting scheduler that tracks proposed slots, records participant votes, and
 * surfaces consensus snapshots for offline planning.
 */
export const meetingSchedulerUx = recipe<MeetingSchedulerArgs>(
  "Meeting Scheduler (UX)",
  ({ participants, slots }) => {
    const votes = cell<VoteRecord>({});
    const history = cell<string[]>([]);
    const latestVote = cell<VoteChange | null>(null);
    const latestSlotUpdate = cell<SlotUpdate | null>(null);

    const participantList = lift(sanitizeParticipants)(participants);
    const slotList = lift(sanitizeSlots)(slots);

    const voteState = lift(
      (
        input: {
          state: VoteRecord | undefined;
          slots: SlotDefinition[];
          participants: ParticipantDefinition[];
        },
      ) => normalizeVoteState(input.state, input.slots, input.participants),
    )({ state: votes, slots: slotList, participants: participantList });

    const slotTallies = lift(
      (
        input: {
          slots: SlotDefinition[];
          participants: ParticipantDefinition[];
          votes: VoteRecord;
        },
      ) => buildVoteTallies(input.slots, input.participants, input.votes),
    )({ slots: slotList, participants: participantList, votes: voteState });

    const consensus = lift(
      (
        input: {
          tallies: SlotVoteSummary[];
          participants: ParticipantDefinition[];
        },
      ) => computeConsensus(input.tallies, input.participants),
    )({ tallies: slotTallies, participants: participantList });

    const consensusLabel = lift((entry: ConsensusSnapshot) => entry.slotLabel)(
      consensus,
    );
    const consensusYes = lift((entry: ConsensusSnapshot) => entry.yes)(
      consensus,
    );
    const outstandingNames = lift(
      (entry: ConsensusSnapshot) =>
        entry.outstandingNames.length > 0
          ? entry.outstandingNames.join(", ")
          : "none",
    )(consensus);
    const outstandingCount = lift(
      (entry: ConsensusSnapshot) => entry.outstanding,
    )(consensus);

    const historyView = lift((entries: string[] | undefined) => {
      return Array.isArray(entries) ? [...entries] : [];
    })(history);
    const latestVoteView = lift((entry: VoteChange | null | undefined) => {
      return entry ? { ...entry } : null;
    })(latestVote);
    const latestSlotUpdateView = lift(
      (entry: SlotUpdate | null | undefined) => {
        return entry ? { ...entry } : null;
      },
    )(latestSlotUpdate);

    const consensusSummary =
      str`Consensus slot: ${consensusLabel} (${consensusYes} yes)`;
    const outstandingSummary =
      str`Outstanding voters: ${outstandingCount} (${outstandingNames})`;

    const consensusStatusLabel = lift(
      (entry: ConsensusSnapshot | undefined) => {
        if (!entry) return "Awaiting responses";
        return entry.status === "locked"
          ? "Consensus locked"
          : "Awaiting responses";
      },
    )(consensus);
    const consensusBadgeVariant = lift(
      (entry: ConsensusSnapshot | undefined) =>
        entry && entry.status === "locked" ? "secondary" : "outline",
    )(consensus);

    const participantCount = lift(
      (entries: ParticipantDefinition[] | undefined) =>
        Array.isArray(entries) ? entries.length : 0,
    )(participantList);
    const slotCount = lift(
      (entries: SlotDefinition[] | undefined) =>
        Array.isArray(entries) ? entries.length : 0,
    )(slotList);

    const totalYes = lift(
      (entries: SlotVoteSummary[] | undefined) => {
        const list = Array.isArray(entries) ? entries : [];
        return list.reduce((total, entry) => total + entry.yes, 0);
      },
    )(slotTallies);
    const totalMaybe = lift(
      (entries: SlotVoteSummary[] | undefined) => {
        const list = Array.isArray(entries) ? entries : [];
        return list.reduce((total, entry) => total + entry.maybe, 0);
      },
    )(slotTallies);
    const totalNo = lift(
      (entries: SlotVoteSummary[] | undefined) => {
        const list = Array.isArray(entries) ? entries : [];
        return list.reduce((total, entry) => total + entry.no, 0);
      },
    )(slotTallies);

    const name = str`Meeting consensus - ${consensusLabel}`;

    const participantOptions = derive(participantList, (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      return list.map((entry) => ({ label: entry.name, value: entry.id }));
    });
    const slotOptions = derive(slotList, (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      return list.map((entry) => ({ label: entry.label, value: entry.id }));
    });

    const selectedParticipant = cell<string>(defaultParticipants[0].id);
    const selectedSlot = cell<string>(defaultSlots[0].id);
    const selectedVote = cell<VoteValue>("yes");

    const voteChoices = [
      { label: "Yes", value: "yes" },
      { label: "Maybe", value: "maybe" },
      { label: "No", value: "no" },
    ];

    const slotDraft = cell("");
    const trimmedSlotDraft = derive(slotDraft, (value) => {
      return typeof value === "string" ? value.trim() : "";
    });

    const ensureValidSelection = compute(() => {
      const participantItems = participantOptions.get();
      const slotItems = slotOptions.get();

      if (!Array.isArray(participantItems) || participantItems.length === 0) {
        selectedParticipant.set("");
      } else if (
        !participantItems.some((item) =>
          item.value === selectedParticipant.get()
        )
      ) {
        selectedParticipant.set(participantItems[0].value ?? "");
      }

      if (!Array.isArray(slotItems) || slotItems.length === 0) {
        selectedSlot.set("");
      } else if (
        !slotItems.some((item) => item.value === selectedSlot.get())
      ) {
        selectedSlot.set(slotItems[0].value ?? "");
      }
    });

    const voteDisabled = lift(
      (
        input: { participant: string | undefined; slot: string | undefined },
      ) => {
        const participantValue = typeof input.participant === "string"
          ? input.participant
          : "";
        const slotValue = typeof input.slot === "string" ? input.slot : "";
        return participantValue.length === 0 || slotValue.length === 0;
      },
    )({ participant: selectedParticipant, slot: selectedSlot });

    const slotDisabled = derive(
      trimmedSlotDraft,
      (value) => (typeof value === "string" ? value.length : 0) === 0,
    );

    const latestVoteSummary = derive(latestVoteView, (entry) => {
      if (!entry) return "No votes recorded yet.";
      return `${entry.participantName} voted ${entry.vote} for ${entry.slotLabel}.`;
    });
    const latestSlotSummary = derive(latestSlotUpdateView, (entry) => {
      if (!entry) return "No new slots proposed.";
      return `Added slot ${entry.label}.`;
    });

    const recentHistory = derive(historyView, (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) {
        return ["Start coordinating by proposing a slot or recording a vote."];
      }
      return [...list].slice(-8).reverse();
    });

    const tallyRows = derive(slotTallies, (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      return list.map((entry) => ({
        slotId: entry.slotId,
        slotLabel: entry.slotLabel,
        yes: entry.yes,
        maybe: entry.maybe,
        no: entry.no,
        pending: entry.pending.length > 0 ? entry.pending.join(", ") : "None",
      }));
    });

    const recordedVotes = lift(
      (entries: SlotVoteSummary[] | undefined) => {
        const list = Array.isArray(entries) ? entries : [];
        return list.reduce(
          (total, entry) => total + entry.yes + entry.maybe + entry.no,
          0,
        );
      },
    )(slotTallies);

    const castVoteControl = castVote({
      participants,
      slots,
      votes,
      history,
      latestVote,
    });
    const proposeSlotControl = proposeSlot({
      participants,
      slots,
      votes,
      history,
      latestSlotUpdate,
    });

    const submitVote = handler<
      unknown,
      {
        participants: Cell<ParticipantInput[]>;
        slots: Cell<SlotInput[]>;
        votes: Cell<VoteRecord>;
        history: Cell<string[]>;
        latestVote: Cell<VoteChange | null>;
        participantSelection: Cell<string>;
        slotSelection: Cell<string>;
        voteSelection: Cell<VoteValue>;
      }
    >((_event, context) => {
      const participant = context.participantSelection.get();
      const slot = context.slotSelection.get();
      const vote = context.voteSelection.get();
      const participantList = sanitizeParticipants(context.participants.get());
      const slotList = sanitizeSlots(context.slots.get());
      if (participantList.length === 0 || slotList.length === 0) {
        return;
      }
      const resolvedVote = normalizeVoteValue(vote);
      if (!resolvedVote) return;
      const participantId = resolveParticipantId(participantList, participant);
      if (!participantId) return;
      const slotId = resolveSlotId(slotList, slot);
      if (!slotId) return;
      const participantEntry = participantList.find((entry) =>
        entry.id === participantId
      );
      const slotEntry = slotList.find((entry) => entry.id === slotId);
      if (!participantEntry || !slotEntry) return;

      const sanitizedState = normalizeVoteState(
        context.votes.get(),
        slotList,
        participantList,
      );
      const slotVotes = { ...sanitizedState[slotId] };
      if (slotVotes[participantId] === resolvedVote) {
        return;
      }
      slotVotes[participantId] = resolvedVote;
      const nextState: VoteRecord = { ...sanitizedState, [slotId]: slotVotes };
      context.votes.set(nextState);

      const yesCount = countVoteType(slotVotes, "yes");
      const maybeCount = countVoteType(slotVotes, "maybe");
      const noCount = countVoteType(slotVotes, "no");

      recordHistoryEntry(
        context.history,
        `${participantEntry.name} voted ${resolvedVote} for ${slotEntry.label}`,
      );

      const change: VoteChange = {
        participantId,
        participantName: participantEntry.name,
        slotId,
        slotLabel: slotEntry.label,
        vote: resolvedVote,
        yesCount,
        maybeCount,
        noCount,
      };
      context.latestVote.set(change);
    })({
      participants,
      slots,
      votes,
      history,
      latestVote,
      participantSelection: selectedParticipant,
      slotSelection: selectedSlot,
      voteSelection: selectedVote,
    });

    const submitSlotProposal = handler<
      unknown,
      {
        participants: Cell<ParticipantInput[]>;
        slots: Cell<SlotInput[]>;
        votes: Cell<VoteRecord>;
        history: Cell<string[]>;
        latestSlotUpdate: Cell<SlotUpdate | null>;
        slotDraft: Cell<string>;
        trimmedDraft: Cell<string>;
      }
    >((_event, context) => {
      const label = context.trimmedDraft.get();
      if (typeof label !== "string" || label.length === 0) {
        return;
      }
      const slotList = sanitizeSlots(context.slots.get());
      const normalizedLabel = normalizeSlotLabel(label, "");
      if (normalizedLabel.length === 0) return;

      const baseId = slugify(normalizedLabel);
      const used = new Set(slotList.map((entry) => entry.id));
      const slotId = ensureUnique(
        baseId.length > 0 ? baseId : slugify(normalizedLabel),
        used,
      );
      const nextSlots = [...slotList, { id: slotId, label: normalizedLabel }];
      context.slots.set(nextSlots.map((entry) => ({ ...entry })));

      const participantsList = sanitizeParticipants(context.participants.get());
      const votesState = normalizeVoteState(
        context.votes.get(),
        nextSlots,
        participantsList,
      );
      context.votes.set(votesState);

      recordHistoryEntry(context.history, `Proposed slot ${normalizedLabel}`);
      context.latestSlotUpdate.set({
        slotId,
        label: normalizedLabel,
        mode: "added",
      });
      context.slotDraft.set("");
    })({
      participants,
      slots,
      votes,
      history,
      latestSlotUpdate,
      slotDraft,
      trimmedDraft: trimmedSlotDraft,
    });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 80rem;
            padding: 0 0.5rem 2rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                  ">
                  <h2 style="
                      margin: 0;
                      font-size: 1.4rem;
                      line-height: 1.3;
                    ">
                    Meeting consensus tracker
                  </h2>
                  <ct-badge variant={consensusBadgeVariant}>
                    {consensusStatusLabel}
                  </ct-badge>
                </div>
                <p style="
                    margin: 0;
                    color: #475569;
                    max-width: 46rem;
                    font-size: 0.95rem;
                  ">
                  Coordinate participant availability, review slot tallies, and
                  lock in the strongest option.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 1rem;
                  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                ">
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.9rem;
                    padding: 0.9rem;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.08em;
                      color: #64748b;
                    ">
                    Consensus slot
                  </span>
                  <strong style="
                      display: block;
                      margin-top: 0.35rem;
                      font-size: 1.1rem;
                      color: #0f172a;
                    ">
                    {consensusLabel}
                  </strong>
                  <span style="
                      display: block;
                      font-size: 0.85rem;
                      color: #475569;
                    ">
                    {consensusSummary}
                  </span>
                </div>
                <div style="
                    background: #eef2ff;
                    border-radius: 0.9rem;
                    padding: 0.9rem;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.08em;
                      color: #6366f1;
                    ">
                    Team readiness
                  </span>
                  <strong style="
                      display: block;
                      margin-top: 0.35rem;
                      font-size: 1.05rem;
                      color: #312e81;
                    ">
                    {outstandingSummary}
                  </strong>
                  <span style="
                      display: block;
                      font-size: 0.8rem;
                      color: #4c1d95;
                    ">
                    Tracking {participantCount} participants across {slotCount}
                    {" "}
                    slots.
                  </span>
                </div>
                <div style="
                    background: #fefce8;
                    border-radius: 0.9rem;
                    padding: 0.9rem;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.08em;
                      color: #a16207;
                    ">
                    Vote totals
                  </span>
                  <strong style="
                      display: block;
                      margin-top: 0.35rem;
                      font-size: 1.05rem;
                      color: #854d0e;
                    ">
                    {totalYes} yes · {totalMaybe} maybe · {totalNo} no
                  </strong>
                  <span style="
                      display: block;
                      font-size: 0.8rem;
                      color: #713f12;
                    ">
                    {recordedVotes} individual responses captured.
                  </span>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.35rem;
                ">
                <h3 style="margin: 0; font-size: 1.15rem;">Record a vote</h3>
                <p style="margin: 0; color: #475569; font-size: 0.9rem;">
                  Select a teammate, choose the slot they are responding to, and
                  capture their vote.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="participant-select"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Participant
                  </label>
                  <ct-select
                    id="participant-select"
                    items={participantOptions}
                    $value={selectedParticipant}
                    aria-label="Participant"
                  />
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="slot-select"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Meeting slot
                  </label>
                  <ct-select
                    id="slot-select"
                    items={slotOptions}
                    $value={selectedSlot}
                    aria-label="Meeting slot"
                  />
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="vote-select"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Vote
                  </label>
                  <ct-select
                    id="vote-select"
                    items={voteChoices}
                    $value={selectedVote}
                    aria-label="Vote"
                  />
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.75rem;
                  align-items: center;
                ">
                <ct-button
                  onClick={submitVote}
                  onct-click={submitVote}
                  disabled={voteDisabled}
                  data-testid="cast-vote-button"
                >
                  Record vote
                </ct-button>
                <span style="font-size: 0.85rem; color: #64748b;">
                  Votes update tallies immediately and log in history.
                </span>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.35rem;
                ">
                <strong style="font-size: 0.9rem; color: #0f172a;">
                  Latest vote
                </strong>
                <span style="font-size: 0.85rem; color: #475569;">
                  {latestVoteSummary}
                </span>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.35rem;
                ">
                <h3 style="margin: 0; font-size: 1.15rem;">Propose a slot</h3>
                <p style="margin: 0; color: #475569; font-size: 0.9rem;">
                  Suggest new availability; the scheduler will normalize labels
                  and update vote tracking.
                </p>
              </div>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  flex-wrap: wrap;
                  align-items: flex-end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                    flex: 1 1 240px;
                  ">
                  <label
                    for="new-slot-label"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Slot label
                  </label>
                  <ct-input
                    id="new-slot-label"
                    placeholder="e.g. Thursday 09:30"
                    $value={slotDraft}
                    aria-describedby="slot-helper-text"
                  />
                </div>
                <ct-button
                  onClick={submitSlotProposal}
                  onct-click={submitSlotProposal}
                  disabled={slotDisabled}
                  data-testid="propose-slot-button"
                >
                  Add slot
                </ct-button>
              </div>
              <span
                id="slot-helper-text"
                style="font-size: 0.8rem; color: #64748b;"
              >
                Duplicate labels are automatically slugified to stay unique.
              </span>

              <div style="
                  background: #ecfeff;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.35rem;
                ">
                <strong style="font-size: 0.9rem; color: #0f172a;">
                  Latest slot update
                </strong>
                <span style="font-size: 0.85rem; color: #0e7490;">
                  {latestSlotSummary}
                </span>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="margin: 0; font-size: 1.15rem;">Slot tallies</h3>
              <ct-table full-width hover>
                <thead>
                  <tr>
                    <th scope="col">Slot</th>
                    <th scope="col">Yes</th>
                    <th scope="col">Maybe</th>
                    <th scope="col">No</th>
                    <th scope="col">Waiting on</th>
                  </tr>
                </thead>
                <tbody>
                  {derive(tallyRows, (rows) =>
                    rows.map((row) => (
                      <tr key={row.slotId}>
                        <th scope="row">{row.slotLabel}</th>
                        <td>{row.yes}</td>
                        <td>{row.maybe}</td>
                        <td>{row.no}</td>
                        <td>{row.pending}</td>
                      </tr>
                    )))}
                </tbody>
              </ct-table>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="margin: 0; font-size: 1.15rem;">Activity log</h3>
              <ol style="
                  margin: 0;
                  padding-left: 1.25rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  color: #475569;
                ">
                {derive(recentHistory, (entries) =>
                  entries.map((entry, index) => (
                    <li key={`history-${index}`}>{entry}</li>
                  )))}
              </ol>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status-announcement"
            style="font-size: 0.85rem; color: #475569;"
          >
            {latestVoteSummary} {latestSlotSummary}
          </div>
        </div>
      ),
      participants: participantList,
      slots: slotList,
      votes: voteState,
      slotTallies,
      consensus,
      consensusSummary,
      outstandingSummary,
      history: historyView,
      latestVote: latestVoteView,
      latestSlotUpdate: latestSlotUpdateView,
      form: {
        participantOptions,
        slotOptions,
        voteChoices,
        selectedParticipant,
        selectedSlot,
        selectedVote,
        slotDraft,
        trimmedSlotDraft,
        voteDisabled,
        slotDisabled,
        ensureValidSelection,
      },
      stats: {
        participantCount,
        slotCount,
        totalYes,
        totalMaybe,
        totalNo,
        recordedVotes,
      },
      controls: {
        castVote: castVoteControl,
        proposeSlot: proposeSlotControl,
        submitVote,
        submitSlotProposal,
      },
    };
  },
);

export default meetingSchedulerUx;
