import { type Charm, CharmManager } from "@commontools/charm";
import { Cell, getEntityId } from "@commontools/runner";
import { NAME } from "@commontools/builder";

export type { Cell, Charm };

export function charmId(charm: Charm): string | undefined {
  const id = getEntityId(charm);
  return id ? id["/"] : undefined;
}

/**
 * Gets mentionable charms by filtering out trash and prioritizing pinned charms
 * @param charmManager The charm manager instance
 * @returns Promise that resolves to an array of mentionable charms (filtered out trash and pinned first)
 */
export async function getMentionableCharms(
  charmManager: CharmManager,
): Promise<Cell<Charm>[]> {
  // Sync all collections to ensure we have the latest data
  await Promise.all([
    charmManager.sync(charmManager.getCharms()),
    charmManager.sync(charmManager.getPinned()),
    charmManager.sync(charmManager.getTrash()),
  ]);

  // Get all collections
  const allCharms = charmManager.getCharms().get();
  const pinnedCharms = charmManager.getPinned().get();
  const trashedCharms = charmManager.getTrash().get();

  // Create a set of trashed charm IDs for quick lookup
  const trashedIds = new Set<string>(
    trashedCharms.map((charm) => charmId(charm)).filter((id): id is string =>
      id !== undefined
    ),
  );

  // Create a set of pinned charm IDs for quick lookup
  const pinnedIds = new Set<string>(
    pinnedCharms.map((charm) => charmId(charm)).filter((id): id is string =>
      id !== undefined
    ),
  );

  // Filter out trashed charms and those without IDs
  const mentionableCharms = allCharms.filter((charm) => {
    const id = charmId(charm);
    return id !== undefined && !trashedIds.has(id);
  });

  // Sort charms with pinned first, then by name
  return mentionableCharms.sort((a, b) => {
    const aId = charmId(a);
    const bId = charmId(b);

    // By this point both aId and bId should be defined, but check just in case
    if (!aId || !bId) {
      console.warn("Unexpected undefined ID in sort function");
      return 0;
    }

    // Sort pinned first
    if (pinnedIds.has(aId) && !pinnedIds.has(bId)) return -1;
    if (!pinnedIds.has(aId) && pinnedIds.has(bId)) return 1;

    // Then sort by name
    const aName = a.get()?.[NAME] ?? "Untitled";
    const bName = b.get()?.[NAME] ?? "Untitled";
    return aName.localeCompare(bName);
  });
}
