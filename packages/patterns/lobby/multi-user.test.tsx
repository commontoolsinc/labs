/// <cts-enable />
import {
  assert,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  addSelfToLobby,
  commitTrustedLobbyAction,
  currentLobbyUserIsAdmin,
  DEFAULT_LOBBY_ROSTER,
  type LobbyAdminRegistryCell,
  type LobbyAdminRegistryValue,
  type LobbyProfile,
  type LobbyProfileCell,
  type LobbyRoster,
  type LobbyRosterCell,
  type LobbyRosterValue,
  TRUSTED_LOBBY_ACTION,
  TRUSTED_LOBBY_SURFACE,
} from "./main.tsx";

const trustedLobbyGesture = {
  surface: TRUSTED_LOBBY_SURFACE,
  action: TRUSTED_LOBBY_ACTION,
};

/**
 * A profile labeled with the principal who wrote it, as a real `#profile` is.
 * The bootstrap role links its subject's profile into a position that names
 * its writer, and the runtime refuses to link a document that carries no
 * label there. Each participant writes their own.
 */
type TestProfile = RepresentsCurrentUser<
  WriteAuthorizedBy<LobbyProfile, typeof writeTestProfile>
>;

/** What `writeTestProfile` is bound to. */
interface TestProfileWrite {
  profile: Writable<TestProfile>;
  value: LobbyProfile;
}

const writeTestProfile = handler<void, TestProfileWrite>((
  _,
  { profile, value },
) => {
  profile.set(value as TestProfile);
});

export interface LobbyMultiUserSetup {
  roster: LobbyRosterCell;
  adminRegistry: LobbyAdminRegistryCell;
  aliceProfile: LobbyProfileCell;
  bobProfile: LobbyProfileCell;
}

export const setup = pattern<Record<string, never>, LobbyMultiUserSetup>(() => {
  const roster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const adminRegistry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  const aliceProfile = Writable.of<TestProfile>();
  const bobProfile = Writable.of<TestProfile>();
  return { roster, adminRegistry, aliceProfile, bobProfile };
});

export const alice = pattern<{ setup: LobbyMultiUserSetup }>(({ setup }) => {
  const writeProfile = writeTestProfile({
    profile: setup.aliceProfile,
    value: { name: "Alice" },
  });
  const addSelf = addSelfToLobby({
    roster: setup.roster,
    viewerProfile: setup.aliceProfile,
    viewerName: "Alice",
  });
  const closeOpenFallback = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster: setup.roster,
    adminRegistry: setup.adminRegistry,
    viewerProfile: setup.aliceProfile,
    viewerName: "Alice",
  });
  const promoteBob = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster: setup.roster,
    adminRegistry: setup.adminRegistry,
    viewerProfile: setup.aliceProfile,
    viewerName: "Alice",
    targetProfile: setup.bobProfile,
  });

  const assert_sees_both = assert(() => {
    const roster = setup.roster.get() as LobbyRoster | undefined;
    return roster?.participants?.[0]?.name === "Alice" &&
      roster?.participants?.[1]?.name === "Bob";
  });
  const assert_alice_is_bootstrap_admin = assert(() =>
    currentLobbyUserIsAdmin(
      setup.aliceProfile,
      setup.roster,
      setup.adminRegistry,
    )
  );
  const assert_only_bob_remains = assert(() => {
    const roster = setup.roster.get() as LobbyRoster | undefined;
    return roster?.participants?.length === 1 &&
      roster?.participants?.[0]?.name === "Bob";
  });

  return {
    [TESTS]: [
      { action: writeProfile },
      { action: addSelf },
      { label: "alice-joined" },
      { await: "bob-joined" },
      { assertion: assert_sees_both },
      {
        action: closeOpenFallback,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_alice_is_bootstrap_admin },
      { label: "fallback-closed" },
      { await: "bob-remove-blocked" },
      { action: promoteBob, trustedUi: trustedLobbyGesture },
      { label: "bob-promoted" },
      { await: "alice-removed" },
      { assertion: assert_only_bob_remains },
    ],
  };
});

export const bob = pattern<{ setup: LobbyMultiUserSetup }>(({ setup }) => {
  const writeProfile = writeTestProfile({
    profile: setup.bobProfile,
    value: { name: "Bob" },
  });
  const addSelf = addSelfToLobby({
    roster: setup.roster,
    viewerProfile: setup.bobProfile,
    viewerName: "Bob",
  });
  const removeAlice = commitTrustedLobbyAction({
    kind: "remove",
    roster: setup.roster,
    adminRegistry: setup.adminRegistry,
    viewerProfile: setup.bobProfile,
    viewerName: "Bob",
    targetProfile: setup.aliceProfile,
  });

  const assert_bob_is_not_admin = assert(() =>
    !currentLobbyUserIsAdmin(
      setup.bobProfile,
      setup.roster,
      setup.adminRegistry,
    )
  );
  const assert_remove_was_blocked = assert(() => {
    const roster = setup.roster.get() as LobbyRoster | undefined;
    return roster?.participants?.[0]?.name === "Alice" &&
      roster?.participants?.[1]?.name === "Bob";
  });
  const assert_bob_is_admin = assert(() =>
    currentLobbyUserIsAdmin(
      setup.bobProfile,
      setup.roster,
      setup.adminRegistry,
    )
  );
  const assert_only_bob_remains = assert(() => {
    const roster = setup.roster.get() as LobbyRoster | undefined;
    return roster?.participants?.length === 1 &&
      roster?.participants?.[0]?.name === "Bob";
  });

  return {
    [TESTS]: [
      { await: "alice-joined" },
      { action: writeProfile },
      { action: addSelf },
      { label: "bob-joined" },
      { await: "fallback-closed" },
      { assertion: assert_bob_is_not_admin },
      { action: removeAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_remove_was_blocked },
      { label: "bob-remove-blocked" },
      { await: "bob-promoted" },
      { assertion: assert_bob_is_admin },
      { action: removeAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_only_bob_remains },
      { label: "alice-removed" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
