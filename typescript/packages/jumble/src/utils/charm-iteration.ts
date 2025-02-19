import { iterate, CharmManager } from "@commontools/charm";
import { charmId } from "@/utils/charms";

export async function performIteration(
  charmManager: CharmManager,
  focusedCharmId: string,
  focusedReplicaId: string,
  input: string,
  variants: boolean,
  preferredModel?: string,
): Promise<string | undefined> {
  try {
    console.log("Performing iteration");
    console.log("Focused Charm ID", focusedCharmId);
    console.log("Focused Replica ID", focusedReplicaId);
    console.log("Input", input);
    console.log("Variants", variants);
    console.log("Preferred Model", preferredModel);
    const charm = await charmManager.get(focusedCharmId);
    console.log("CHARM", charm);
    const newCharmId = await iterate(charmManager, charm ?? null, input, false, preferredModel);
    console.log("NEW CHARM ID", newCharmId);
    if (!newCharmId) return;
    return `/${focusedReplicaId}/${charmId(newCharmId)}`;
  } catch (error) {
    console.error("Edit recipe error:", error);
  }
}
