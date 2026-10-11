/**
 * Lobby — who may write the bootstrap admin role
 *
 * While the explicit roster is empty, `bootstrapAdmin` is the whole explicit
 * admin policy, so it names the one handler that may modify it. These tests
 * cover the first-admin bootstrap on a fresh registry, a write to the role
 * from code the role does not name (before and after the bootstrap), and a
 * registry stored before the role named its writer, which still loads and
 * still lets its admin act.
 *
 * A refused write is reported as a CFC policy warning, which is why console
 * warnings are allowed.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  handler,
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
  LOBBY_ADMIN_INTEGRITY,
  type LobbyAdminRegistryCell,
  type LobbyAdminRegistryStoredValue,
  type LobbyAdminRegistryValue,
  type LobbyProfile,
  type LobbyProfileCell,
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
 * The role links its subject's profile, and the runtime refuses to link a
 * document that carries no label into a position that names its writer.
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

/** A role as code that knows the registry's shape and none of its policy. */
interface PlainRole {
  subject: Cell<LobbyProfile>;
  displayName: string;
}

/** What `plantBootstrapAdmin` is bound to. */
interface PlantState {
  registry: Writable<{ bootstrapAdmin?: PlainRole }>;
  profile: Cell<LobbyProfile>;
  name: string;
}

/**
 * A handler the role does not name, setting the bootstrap role to a profile
 * of its choosing.
 */
const plantBootstrapAdmin = handler<void, PlantState>((
  _,
  { registry, profile, name },
) => {
  registry.key("bootstrapAdmin").set({ subject: profile, displayName: name });
});

/**
 * The registry as it was stored before the bootstrap role named its writer:
 * the role carried the endorsement mint and nothing else.
 */
interface LegacyRegistry {
  bootstrapAdmin?: AddIntegrity<
    PlainRole,
    readonly [typeof LOBBY_ADMIN_INTEGRITY]
  >;
  everyoneIsAdmin?: boolean;
}

/** What `storeLegacyBootstrap` is bound to. */
interface LegacyBootstrapState {
  registry: Writable<LegacyRegistry>;
  profile: Cell<LobbyProfile>;
  name: string;
}

/** Stores an explicit policy whose only admin is the bootstrap role. */
const storeLegacyBootstrap = handler<void, LegacyBootstrapState>((
  _,
  { registry, profile, name },
) => {
  registry.set({
    bootstrapAdmin: { subject: profile, displayName: name },
    everyoneIsAdmin: false,
  } as LegacyRegistry);
});

const bootstrapName = (registry: LobbyAdminRegistryCell): string | undefined =>
  (registry.get() as LobbyAdminRegistryStoredValue | undefined)?.bootstrapAdmin
    ?.displayName;

const isAdmin = (
  profile: LobbyProfileCell,
  roster: LobbyRosterCell,
  registry: LobbyAdminRegistryCell,
): boolean => currentLobbyUserIsAdmin(profile, roster, registry);

export default pattern(() => {
  const alice = Writable.of<TestProfile>();
  const bob = Writable.of<TestProfile>();
  const mallory = Writable.of<TestProfile>();
  const writeAlice = writeTestProfile({
    profile: alice,
    value: { name: "Alice" },
  });
  const writeBob = writeTestProfile({ profile: bob, value: { name: "Bob" } });
  const writeMallory = writeTestProfile({
    profile: mallory,
    value: { name: "Mallory" },
  });

  // ============================================================
  // Subject 1: a fresh registry bootstraps its first admin, and code the
  // role does not name cannot replace it
  // ============================================================

  const roster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const registry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  const aliceJoins = addSelfToLobby({
    roster,
    viewerProfile: alice,
    viewerName: "Alice",
  });
  const malloryJoins = addSelfToLobby({
    roster,
    viewerProfile: mallory,
    viewerName: "Mallory",
  });
  const aliceLocksDown = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster,
    adminRegistry: registry,
    viewerProfile: alice,
    viewerName: "Alice",
  });
  // Typed by the registry's shape alone, so the write carries none of the
  // role's policy and only the stored contract can refuse it.
  const malloryPlantsSelf = plantBootstrapAdmin({
    registry: registry as never,
    profile: mallory,
    name: "Mallory",
  });

  const assert_alice_bootstrapped = assert(() =>
    bootstrapName(registry) === "Alice" &&
    isAdmin(alice, roster, registry) &&
    !isAdmin(mallory, roster, registry)
  );
  const assert_plant_after_bootstrap_refused = assert(() =>
    bootstrapName(registry) === "Alice" &&
    isAdmin(alice, roster, registry) &&
    !isAdmin(mallory, roster, registry)
  );

  // ============================================================
  // Subject 2: a role planted before the bootstrap is refused, so the
  // bootstrap still names the person who locked the lobby down
  // ============================================================

  const earlyRoster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const earlyRegistry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  const aliceJoinsEarly = addSelfToLobby({
    roster: earlyRoster,
    viewerProfile: alice,
    viewerName: "Alice",
  });
  const malloryJoinsEarly = addSelfToLobby({
    roster: earlyRoster,
    viewerProfile: mallory,
    viewerName: "Mallory",
  });
  const malloryPlantsEarly = plantBootstrapAdmin({
    registry: earlyRegistry as never,
    profile: mallory,
    name: "Mallory",
  });
  const aliceLocksDownEarly = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster: earlyRoster,
    adminRegistry: earlyRegistry,
    viewerProfile: alice,
    viewerName: "Alice",
  });

  const assert_early_plant_refused = assert(() =>
    bootstrapName(earlyRegistry) === undefined
  );
  const assert_lockdown_names_alice = assert(() =>
    bootstrapName(earlyRegistry) === "Alice" &&
    isAdmin(alice, earlyRoster, earlyRegistry) &&
    !isAdmin(mallory, earlyRoster, earlyRegistry)
  );

  // ============================================================
  // Subject 3: a registry stored before the role named its writer
  // ============================================================

  // The stored role keeps working: its admin is recognized and can promote a
  // second admin through the reviewed handler. The stored role took no writer
  // contract when it was written, and the new schema does not adopt one over
  // an existing value, so it stays writable by other code. Once the explicit
  // roster holds a role, the bootstrap role no longer decides anything, which
  // is what the last step checks.

  const legacyRoster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const legacyRegistry = Writable.of<LegacyRegistry>();
  // The lobby reads the stored registry through its own contract.
  const legacyAsLobby: LobbyAdminRegistryCell = legacyRegistry as never;
  const storeLegacy = storeLegacyBootstrap({
    registry: legacyRegistry,
    profile: alice,
    name: "Alice",
  });
  const aliceJoinsLegacy = addSelfToLobby({
    roster: legacyRoster,
    viewerProfile: alice,
    viewerName: "Alice",
  });
  const bobJoinsLegacy = addSelfToLobby({
    roster: legacyRoster,
    viewerProfile: bob,
    viewerName: "Bob",
  });
  const malloryJoinsLegacy = addSelfToLobby({
    roster: legacyRoster,
    viewerProfile: mallory,
    viewerName: "Mallory",
  });
  const alicePromotesBob = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster: legacyRoster,
    adminRegistry: legacyAsLobby,
    viewerProfile: alice,
    viewerName: "Alice",
    targetProfile: bob,
  });
  const malloryPlantsLegacy = plantBootstrapAdmin({
    registry: legacyRegistry as never,
    profile: mallory,
    name: "Mallory",
  });

  const assert_legacy_bootstrap_loads = assert(() =>
    bootstrapName(legacyAsLobby) === "Alice" &&
    isAdmin(alice, legacyRoster, legacyAsLobby) &&
    !isAdmin(bob, legacyRoster, legacyAsLobby)
  );
  const assert_legacy_admin_promotes = assert(() =>
    isAdmin(alice, legacyRoster, legacyAsLobby) &&
    isAdmin(bob, legacyRoster, legacyAsLobby)
  );
  const assert_legacy_roster_decides = assert(() =>
    !isAdmin(mallory, legacyRoster, legacyAsLobby) &&
    isAdmin(alice, legacyRoster, legacyAsLobby) &&
    isAdmin(bob, legacyRoster, legacyAsLobby)
  );

  return {
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: writeAlice },
      { action: writeBob },
      { action: writeMallory },

      // Subject 1
      { action: aliceJoins },
      {
        action: aliceLocksDown,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { action: malloryJoins },
      { assertion: assert_alice_bootstrapped },
      // Sent from the reviewed surface, so only the writer binding refuses it.
      { action: malloryPlantsSelf, trustedUi: trustedLobbyGesture },
      { assertion: assert_plant_after_bootstrap_refused },

      // Subject 2
      { action: aliceJoinsEarly },
      { action: malloryJoinsEarly },
      { action: malloryPlantsEarly, trustedUi: trustedLobbyGesture },
      { assertion: assert_early_plant_refused },
      {
        action: aliceLocksDownEarly,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_lockdown_names_alice },

      // Subject 3
      { action: storeLegacy },
      { action: aliceJoinsLegacy },
      { action: bobJoinsLegacy },
      { action: malloryJoinsLegacy },
      { assertion: assert_legacy_bootstrap_loads },
      { action: alicePromotesBob, trustedUi: trustedLobbyGesture },
      { assertion: assert_legacy_admin_promotes },
      { action: malloryPlantsLegacy, trustedUi: trustedLobbyGesture },
      { assertion: assert_legacy_roster_decides },
    ],
  };
});
