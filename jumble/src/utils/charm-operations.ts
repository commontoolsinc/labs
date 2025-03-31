import { castNewRecipe, Charm, CharmManager } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { getCharmNameAsCamelCase } from "@/utils/format.ts";

export async function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  goal: string,
  cells?: Record<string, Cell<any>>,
  existingSpec?: string,
  existingPlan?: string,
): Promise<Cell<Charm>> {
  console.log("extendCharm called with existingSpec and existingPlan:", 
    { hasExistingSpec: !!existingSpec, hasExistingPlan: !!existingPlan });
  
  const charm = (await charmManager.get(focusedCharmId, false))!;

  const shadowId = getCharmNameAsCamelCase(charm, cells ?? {});

  return castNewRecipe(
    charmManager,
    goal,
    { ...cells, [shadowId]: charm },
    existingSpec,
    existingPlan,
  );
}
