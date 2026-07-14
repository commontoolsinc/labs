import { computed, pattern, UI, Writable } from "commonfabric";
import Lobby, {
  addSelfToLobby,
  commitTrustedLobbyAction,
  currentLobbyUserIsAdmin,
  DEFAULT_LOBBY_ROSTER,
  type LobbyAdminRegistryValue,
  lobbyAdminRolesValue,
  lobbyEveryoneIsAdmin,
  lobbyParticipantsValue,
  type LobbyProfile,
  type LobbyRosterCell,
  type LobbyRosterValue,
  TRUSTED_LOBBY_ACTION,
  TRUSTED_LOBBY_SURFACE,
} from "./main.tsx";

const trustedLobbyGesture = {
  surface: TRUSTED_LOBBY_SURFACE,
  action: TRUSTED_LOBBY_ACTION,
};

type LobbyInputArg = Parameters<typeof Lobby>[0];

const participantNames = (roster: LobbyRosterCell): string[] =>
  lobbyParticipantsValue(roster).map((participant) => participant.name);

export default pattern(() => {
  const roster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const adminRegistry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  const aliceProfile = Writable.of<LobbyProfile>({ name: "Alice" });
  const bobProfile = Writable.of<LobbyProfile>({ name: "Bob" });
  const firstAlexProfile = Writable.of<LobbyProfile>({ name: "Alex" });
  const secondAlexProfile = Writable.of<LobbyProfile>({ name: "Alex" });
  const blankProfile = Writable.of<LobbyProfile>({ name: "   " });

  const aliceAddSelf = addSelfToLobby({
    roster,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
  });
  const bobJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
  });
  const blankJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: blankProfile,
    viewerName: "",
  });
  const firstAlexJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: firstAlexProfile,
    viewerName: "Alex",
  });
  const secondAlexJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: secondAlexProfile,
    viewerName: "Alex",
  });

  const aliceSetEveryone = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster,
    adminRegistry,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
  });
  const bobSetEveryone = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
  });
  const bobRemoveAlice = commitTrustedLobbyAction({
    kind: "remove",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
    targetProfile: aliceProfile,
  });
  const aliceToggleBobAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster,
    adminRegistry,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
    targetProfile: bobProfile,
  });
  const bobToggleSelfAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
    targetProfile: bobProfile,
  });

  const lobby = Lobby({ roster, adminRegistry } as LobbyInputArg);

  const assert_initial_open_fallback = computed(() =>
    lobbyParticipantsValue(roster).length === 0 &&
    lobbyAdminRolesValue(adminRegistry).length === 0 &&
    lobbyEveryoneIsAdmin(adminRegistry) === true
  );
  const assert_alice_joined_once = computed(() =>
    participantNames(roster).join(",") === "Alice" &&
    currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry)
  );
  const assert_blank_profile_rejected = computed(() =>
    participantNames(roster).join(",") === "Alice"
  );
  const assert_both_are_admin_by_fallback = computed(() =>
    participantNames(roster).join(",") === "Alice,Bob" &&
    currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry) &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_bob_removed_alice_while_open = computed(() =>
    participantNames(roster).join(",") === "Bob"
  );
  const assert_lockdown_bootstraps_alice = computed(() => {
    const roles = lobbyAdminRolesValue(adminRegistry);
    return lobbyEveryoneIsAdmin(adminRegistry) === false &&
      roles.length === 1 &&
      currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry) &&
      !currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry);
  });
  const assert_non_admin_remove_is_blocked = computed(() =>
    participantNames(roster).join(",") === "Bob,Alice"
  );
  const assert_bob_promoted = computed(() =>
    lobbyAdminRolesValue(adminRegistry).length === 2 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_bob_removed_alice_and_role = computed(() =>
    participantNames(roster).join(",") === "Bob" &&
    lobbyAdminRolesValue(adminRegistry).length === 1 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_last_admin_removal_blocked = computed(() =>
    lobbyAdminRolesValue(adminRegistry).length === 1 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_open_policy_restored = computed(() =>
    lobbyEveryoneIsAdmin(adminRegistry) === true &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_same_name_profiles_both_join = computed(() =>
    participantNames(roster).filter((name) => name === "Alex").length === 2
  );
  const assert_public_output_count = computed(() =>
    lobby.participantCount === 3 &&
    lobby.allParticipants.length === 3 &&
    lobby.participants.length === 3
  );
  const assert_public_output_policy = computed(() =>
    lobby.everyoneIsAdmin === true
  );
  const assert_public_output_is_profile_free = computed(() =>
    lobby.allParticipants[0]?.name === "Bob" &&
    lobby.allParticipants[1]?.name === "Alex" &&
    lobby.allParticipants[2]?.name === "Alex" &&
    lobby.participants[0]?.name === lobby.allParticipants[0]?.name
  );

  return {
    tests: [
      { assertion: assert_initial_open_fallback },
      { action: aliceAddSelf },
      { action: aliceAddSelf },
      { assertion: assert_alice_joined_once },
      { action: blankJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_blank_profile_rejected },
      { action: bobJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_both_are_admin_by_fallback },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_removed_alice_while_open },
      { action: aliceAddSelf },
      {
        action: aliceSetEveryone,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_lockdown_bootstraps_alice },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_non_admin_remove_is_blocked },
      { action: aliceToggleBobAdmin, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_promoted },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_removed_alice_and_role },
      { action: bobToggleSelfAdmin, trustedUi: trustedLobbyGesture },
      { assertion: assert_last_admin_removal_blocked },
      {
        action: bobSetEveryone,
        event: { everyoneIsAdmin: true },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_open_policy_restored },
      { action: firstAlexJoin, trustedUi: trustedLobbyGesture },
      { action: secondAlexJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_same_name_profiles_both_join },
      { assertion: assert_public_output_count },
      { assertion: assert_public_output_policy },
      { assertion: assert_public_output_is_profile_free },
      // With no profile wish resolved, this materializes the non-admin branch.
      { render: lobby[UI] },
    ],
    roster,
    adminRegistry,
  };
});
