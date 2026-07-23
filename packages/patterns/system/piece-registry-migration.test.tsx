import { assert, computed, pattern, Writable } from "commonfabric";
import { migratePieceRegistry } from "./piece-registry-migration.ts";

export default pattern(() => {
  const legacy = new Writable(["legacy"]);
  const migratedRegistry = new Writable<string[]>([]);
  const migrationComplete = new Writable(false);

  const conflictingLegacy = new Writable(["legacy"]);
  const canonicalRegistry = new Writable(["canonical"]);
  const canonicalMigrationComplete = new Writable(false);

  const retiredLegacy = new Writable(["legacy"]);
  const completedRegistry = new Writable<string[]>([]);
  const alreadyComplete = new Writable(true);

  computed(() => {
    migratePieceRegistry(legacy, migratedRegistry, migrationComplete);
    migratePieceRegistry(
      conflictingLegacy,
      canonicalRegistry,
      canonicalMigrationComplete,
    );
    migratePieceRegistry(retiredLegacy, completedRegistry, alreadyComplete);
  });

  const assert_legacy_registry_is_copied = assert(() =>
    migratedRegistry.get().length === 1 &&
    migratedRegistry.get()[0] === "legacy" &&
    migrationComplete.get() === true
  );
  const assert_canonical_registry_wins = assert(() =>
    canonicalRegistry.get().length === 1 &&
    canonicalRegistry.get()[0] === "canonical" &&
    canonicalMigrationComplete.get() === true
  );
  const assert_completed_migration_does_not_run = assert(() =>
    completedRegistry.get().length === 0 && alreadyComplete.get() === true
  );

  return {
    tests: [
      { assertion: assert_legacy_registry_is_copied },
      { assertion: assert_canonical_registry_wins },
      { assertion: assert_completed_migration_does_not_run },
    ],
  };
});
