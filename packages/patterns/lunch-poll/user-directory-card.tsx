import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  safeDateNow,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { ClaimHostEvent, JoinEvent, User } from "./main.tsx";

type UsersCell = Writable<User[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const trimmedName = (n: string | undefined) => (n ?? "").trim();
const colorForIndex = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

const joinAs = handler<JoinEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  joinName: NameCell;
  profileName: string;
  profileAvatar: string;
}>(
  (
    { name },
    { users, myName, adminName, joinName, profileName, profileAvatar },
  ) => {
    const override = trimmedName(name) || trimmedName(joinName.get());
    const trimmed = override || trimmedName(profileName);
    if (!trimmed) return;
    const current = trimmedName(myName.get());
    if (current) return;
    const existing = users.get();
    if (existing.some((u) => u.name === trimmed)) return;
    const user: User = {
      name: trimmed,
      avatar: override ? "" : (profileAvatar ?? "").trim(),
      color: colorForIndex(existing.length),
      joinedAt: safeDateNow(),
    };
    users.push(user);
    myName.set(trimmed);
    if (trimmedName(adminName.get()) === "") {
      adminName.set(trimmed);
    }
    joinName.set("");
  },
);

const claimHost = handler<ClaimHostEvent, {
  myName: NameCell;
  adminName: NameCell;
}>((_, { myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  if (trimmedName(adminName.get()) === me) return;
  adminName.set(me);
});

export interface UserDirectoryCardInput {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
}

export interface UserDirectoryCardOutput {
  [NAME]: string;
  [UI]: VNode;
  me: string;
  isJoined: boolean;
  isAdmin: boolean;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
}

export default pattern<UserDirectoryCardInput, UserDirectoryCardOutput>(
  ({ users, myName, adminName }) => {
    const joinName = Writable.perSession.of<string>("");
    const claimHostRevealed = Writable.perSession.of<boolean>(false);
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const profileName = computed(() => profileNameWish.result ?? "");
    const profileAvatar = computed(() => profileAvatarWish.result ?? "");
    const boundJoin = joinAs({
      users,
      myName,
      adminName,
      joinName,
      profileName,
      profileAvatar,
    });
    const boundClaimHost = claimHost({ myName, adminName });

    const me = computed(() => trimmedName(myName.get()));
    const isJoined = computed(() => trimmedName(myName.get()) !== "");
    const isAdmin = computed(() => {
      const viewer = trimmedName(myName.get());
      return viewer !== "" && viewer === trimmedName(adminName.get());
    });
    const joinHint = computed(() =>
      trimmedName(adminName.get()) === ""
        ? "First to join becomes the host."
        : `Hosted by ${trimmedName(adminName.get())}.`
    );
    const canClaimHost = computed(() => {
      const viewer = trimmedName(myName.get());
      return viewer !== "" && viewer !== trimmedName(adminName.get());
    });
    const isClaimHostRevealed = computed(() => claimHostRevealed.get());

    return {
      [NAME]: "Lunch poll directory",
      [UI]: (
        <div style="display:contents">
          {isJoined ? null : (
            <div
              style={{
                padding: "16px",
                marginBottom: "16px",
                border: "1px solid #fde68a",
                backgroundColor: "#fef3c7",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#92400e",
                  marginBottom: "8px",
                }}
              >
                Join the poll
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "#78350f",
                  marginBottom: "12px",
                }}
              >
                {joinHint}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                }}
              >
                <cf-input
                  $value={joinName}
                  placeholder="Your name…"
                  aria-label="Your name"
                  timing-strategy="immediate"
                  style="flex:1"
                />
                <cf-button onClick={boundJoin}>Join</cf-button>
              </div>
            </div>
          )}

          {canClaimHost
            ? (isClaimHostRevealed
              ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                    padding: "8px 12px",
                    marginBottom: "16px",
                    backgroundColor: "#eef2ff",
                    border: "1px solid #c7d2fe",
                    borderRadius: "8px",
                    fontSize: "13px",
                    color: "#3730a3",
                  }}
                >
                  <span>{joinHint}</span>
                  <cf-button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      boundClaimHost.send({});
                      claimHostRevealed.set(false);
                    }}
                  >
                    Become host
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => claimHostRevealed.set(false)}
                  >
                    Cancel
                  </cf-button>
                </div>
              )
              : (
                <div style={{ marginBottom: "16px" }}>
                  <button
                    type="button"
                    aria-label="Hosting info — click to take over as host"
                    title="Click to take over as host"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontSize: "13px",
                      color: "#6b7280",
                      cursor: "pointer",
                      textDecoration: "underline dotted",
                      textUnderlineOffset: "3px",
                    }}
                    onClick={() => claimHostRevealed.set(true)}
                  >
                    {joinHint}
                  </button>
                </div>
              ))
            : null}
        </div>
      ),
      me,
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
    };
  },
);
