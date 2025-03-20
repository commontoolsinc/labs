import { castNewRecipe, Charm, CharmManager } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { getCharmNameAsCamelCase } from "@/utils/format.ts";

export async function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  goal: string,
  cells?: Record<string, Cell<any>>,
): Promise<Cell<Charm>> {
  const charm = (await charmManager.get(focusedCharmId, false))!;

  const shadowId = getCharmNameAsCamelCase(charm, cells ?? {});

  return castNewRecipe(
    charmManager,
    goal,
    { ...cells, [shadowId]: charm },
  );
}
