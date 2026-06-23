/**
 * Idiomatic lunch-poll performance fixture.
 *
 * This is the reference-addressed version of the contention experiment. It
 * deliberately avoids app-level string IDs: option identity is the option cell
 * itself, participant identity is the participant cell itself, and all matching
 * uses `equals()`.
 *
 * Setup still appends participants and options to shared arrays, so the
 * diagnostic driver runs joins and option creation serially. The measured hot
 * path is concurrent voting: each user's PerUser state holds a live reference
 * to their participant element in the shared PerSpace participants array, and
 * the vote handler writes under that participant child cell.
 */
import {
  type Cell,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface Option {
  title: string;
  addedByName: string;
}

export type VoteColor = "green" | "yellow" | "red";
export type OptionCell = Cell<Option>;

export interface Vote {
  option: OptionCell;
  voteType: VoteColor;
}

export interface Participant {
  name: string;
  color: string;
  joinedAt: number;
  votes: Vote[] | Default<[]>;
}

export type ParticipantCell = Writable<Participant>;

export interface ViewerState {
  participant?: Participant;
}

export interface JoinEvent {
  name?: string;
}

export interface AddOptionEvent {
  title?: string;
}

export interface CastVoteEvent {
  option: OptionCell;
  voteType: VoteColor;
}

export type ClearMyVotesEvent = Record<PropertyKey, never>;

type OptionsCell = Writable<Option[] | Default<[]>>;
type ParticipantsCell = Writable<Participant[] | Default<[]>>;
type EmptyViewer = Record<PropertyKey, never>;
type ViewerCell = Writable<ViewerState>;
type DraftCell = Writable<string | Default<"">>;

interface ParticipantSummary {
  name: string;
  color: string;
  joinedAt: number;
  voteCount: number;
}

interface VoteSummary {
  voterName: string;
  optionTitle: string;
  voteType: VoteColor;
}

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const VOTE_SWATCH: Record<VoteColor, string> = {
  green: "#2f8a64",
  yellow: "#d4a82f",
  red: "#a33b35",
};

const trimmed = (value: string | undefined): string => (value ?? "").trim();
const colorForIndex = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length];

const optionTitle = (option: OptionCell | undefined): string =>
  option ? trimmed(option.get()?.title) : "";

const joinAs = handler<JoinEvent, {
  participants: ParticipantsCell;
  viewer: ViewerCell;
  joinDraft: DraftCell;
}>(({ name }, { participants, viewer, joinDraft }) => {
  if (viewer.get()?.participant) return;
  const nextName = trimmed(name) || trimmed(joinDraft.get());
  if (!nextName) return;

  const current = participants.get();
  participants.push({
    name: nextName,
    color: colorForIndex(current.length),
    joinedAt: safeDateNow(),
    votes: [],
  });
  viewer.set({ participant: participants.key(current.length) });
  joinDraft.set("");
});

const addOption = handler<AddOptionEvent, {
  options: OptionsCell;
  optionDraft: DraftCell;
}>(({ title }, { options, optionDraft }) => {
  const nextTitle = trimmed(title) || trimmed(optionDraft.get());
  if (!nextTitle) return;
  options.push({
    title: nextTitle,
    addedByName: "",
  });
  optionDraft.set("");
});

const castVote = handler<CastVoteEvent, { viewer: ViewerCell }>(
  ({ option, voteType }, { viewer }) => {
    const participant = viewer.key("participant");
    if (!participant.get() || !option) return;

    const votes = participant.key("votes");
    const rawVotes = votes.get();
    let current: readonly Vote[] = Array.isArray(rawVotes)
      ? rawVotes as readonly Vote[]
      : [];
    if (!Array.isArray(rawVotes)) {
      votes.set([]);
    }

    const existingIndex = current.findIndex((vote: Vote) =>
      equals(vote.option, option)
    );
    if (existingIndex >= 0) {
      const existing = current[existingIndex];
      if (existing.voteType === voteType) {
        votes.set(current.toSpliced(existingIndex, 1));
        return;
      }
      votes.key(existingIndex).key("voteType").set(voteType);
      return;
    }
    votes.push({ option, voteType });
  },
);

const clearMyVotes = handler<ClearMyVotesEvent, { viewer: ViewerCell }>(
  (_event, { viewer }) => {
    const participant = viewer.key("participant");
    if (!participant.get()) return;
    participant.key("votes").set([]);
  },
);

const participantSummariesFor = (
  participants: readonly Participant[],
): ParticipantSummary[] =>
  participants.map((participant) => ({
    name: participant.name,
    color: participant.color,
    joinedAt: participant.joinedAt,
    voteCount: participant.votes?.length ?? 0,
  }));

const voteSummariesFor = (
  participants: readonly Participant[],
): VoteSummary[] => {
  const rows: VoteSummary[] = [];
  for (const participant of participants) {
    for (const vote of participant.votes ?? []) {
      const title = optionTitle(vote.option);
      if (!title) continue;
      rows.push({
        voterName: participant.name,
        optionTitle: title,
        voteType: vote.voteType,
      });
    }
  }
  return rows;
};

export interface ReferencePollInput {
  options?: PerSpace<Option[] | Default<[]>>;
  participants?: PerSpace<Participant[] | Default<[]>>;
  viewer?: PerUser<ViewerState | Default<EmptyViewer>>;
}

export interface ReferencePollOutput {
  [NAME]: string;
  [UI]: VNode;
  options: readonly Option[];
  users: readonly ParticipantSummary[];
  votes: readonly VoteSummary[];
  history: readonly never[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  historyCount: number;
  isJoined: boolean;
  isAdmin: boolean;
  homePageLookupUrls: readonly string[];
  joinAs: Stream<JoinEvent>;
  addOption: Stream<AddOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVotes: Stream<ClearMyVotesEvent>;
}

export default pattern<ReferencePollInput, ReferencePollOutput>(
  ({ options, participants, viewer }) => {
    const joinDraft = Writable.perSession.of<string>("");
    const optionDraft = Writable.perSession.of<string>("");
    const boundJoinAs = joinAs({ participants, viewer, joinDraft });
    const boundAddOption = addOption({ options, optionDraft });
    const boundCastVote = castVote({ viewer });
    const boundClearMyVotes = clearMyVotes({ viewer });

    const userRows = computed(() => participantSummariesFor(participants));
    const voteRows = computed(() => voteSummariesFor(participants));
    const myName = computed(() => trimmed(viewer?.participant?.name));
    const isJoined = computed(() => viewer?.participant !== undefined);

    return {
      [NAME]: "Reference lunch poll perf fixture",
      [UI]: (
        <cf-theme
          theme={{
            colorScheme: "light",
            borderRadius: "8px",
            colors: {
              primary: "#2f6f4e",
              primaryForeground: "#ffffff",
              background: "#f1f5ef",
              surface: "#ffffff",
              text: "#1d2a1f",
              textMuted: "#5d6f63",
              border: "#cbd9cf",
            },
          }}
        >
          <cf-screen>
            <div slot="header" style="padding:16px 20px;background:white">
              <h2 style="margin:0;font-size:20px">Reference lunch poll</h2>
              <div style="font-size:13px;color:#5d6f63;margin-top:4px">
                {userRows.length} joined | {options.length} options |{" "}
                {voteRows.length} votes
              </div>
            </div>
            <div style="padding:16px;display:flex;flex-direction:column;gap:16px">
              <div style="display:flex;align-items:center;gap:8px">
                <strong>{myName}</strong>
                <cf-button
                  size="sm"
                  variant="secondary"
                  onClick={boundClearMyVotes}
                >
                  Clear my votes
                </cf-button>
              </div>

              <div style="display:flex;gap:8px">
                <cf-input
                  $value={joinDraft}
                  placeholder="Your name"
                  timing-strategy="immediate"
                  style="flex:1"
                />
                <cf-button onClick={boundJoinAs}>Join</cf-button>
              </div>

              <div style="display:flex;gap:8px">
                <cf-input
                  $value={optionDraft}
                  placeholder="Restaurant"
                  timing-strategy="immediate"
                  style="flex:1"
                />
                <cf-button onClick={boundAddOption}>Add</cf-button>
              </div>

              <div style="display:flex;flex-direction:column;gap:10px">
                {options.map((option) => (
                  <div
                    style={{
                      background: "white",
                      border: "1px solid #cbd9cf",
                      borderRadius: "8px",
                      padding: "12px",
                    }}
                  >
                    <div style="font-weight:700;margin-bottom:8px">
                      {option.title}
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                      {(["green", "yellow", "red"] as const).map((
                        voteType,
                      ) => (
                        <cf-button
                          size="sm"
                          style={{
                            background: VOTE_SWATCH[voteType],
                            color: "white",
                          }}
                          onClick={() =>
                            boundCastVote.send({ option, voteType })}
                        >
                          {voteType}
                        </cf-button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </cf-screen>
        </cf-theme>
      ),
      options,
      users: userRows,
      votes: voteRows,
      history: [],
      adminName: userRows[0]?.name ?? "",
      myName,
      userCount: userRows.length,
      optionCount: options.length,
      voteCount: voteRows.length,
      historyCount: 0,
      isJoined,
      isAdmin: isJoined,
      homePageLookupUrls: [],
      joinAs: boundJoinAs,
      addOption: boundAddOption,
      castVote: boundCastVote,
      clearMyVotes: boundClearMyVotes,
    };
  },
);
