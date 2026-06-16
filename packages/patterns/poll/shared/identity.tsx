import { handler, safeDateNow } from "commonfabric";

import {
  type ClaimHostEvent,
  type JoinEvent,
  type NameCell,
  type User,
  type UsersCell,
} from "./types.tsx";
import { colorForIndex, trimmedName } from "./constants.tsx";

// `profileName`/`profileAvatar` arrive as plain strings resolved from the
// viewer's shared profile (named `computed` values auto-unwrap as handler
// state). An explicit `name` in the event (tests, headless drivers) overrides
// the profile name — and then deliberately skips the profile avatar.
export const joinAs = handler<JoinEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  joinName?: NameCell;
  profileName: string;
  profileAvatar: string;
}>(
  (
    { name },
    { users, myName, adminName, joinName, profileName, profileAvatar },
  ) => {
    // Name priority: an explicit event `name` (tests/headless) wins, then the
    // free-text join field when present, then the viewer's shared profile name
    // as a graceful fallback for anyone who already made a profile and didn't
    // type anything.
    const override = trimmedName(name) ||
      (joinName ? trimmedName(joinName.get()) : "");
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
    if (joinName) {
      joinName.set("");
    }
  },
);

// Open host takeover: any joined participant can claim the host role, which
// transfers it away from the current host (isAdmin is derived from this). This
// is deliberately ungated beyond "must be joined" — see ADMIN-FUTURE.md for the
// kernel-level authority model this pattern-level check is a placeholder for.
export const claimHost = handler<ClaimHostEvent, {
  myName: NameCell;
  adminName: NameCell;
}>((_, { myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  if (trimmedName(adminName.get()) === me) return;
  adminName.set(me);
});
