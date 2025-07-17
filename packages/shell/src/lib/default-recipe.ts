import { CharmController, CharmsController } from "@commontools/charm/ops";
import { processSchema } from "@commontools/charm";

const ALL_CHARMS_ID =
  "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";
const DEFAULT_CHARM_NAME = "DefaultCharmList";

export async function create(cc: CharmsController): Promise<CharmController> {
  const manager = cc.manager();
  const runtime = manager.runtime;

  const recipeContent = await runtime.staticCache.getText(
    "recipes/charm-list.tsx",
  );
  const charm = await cc.create(recipeContent);

  const tx = runtime.edit();
  const charmCell = charm.getCell();
  const sourceCell = charmCell.getSourceCell(processSchema);

  if (!sourceCell) {
    // Not sure how/when this happens
    throw new Error("Could not create and link default recipe.");
  }

  // Get the well-known allCharms cell using its EntityId format
  const allCharmsCell = await manager.getCellById({ "/": ALL_CHARMS_ID });
  sourceCell.withTx(tx).key("argument").key("allCharms").set(
    allCharmsCell.withTx(tx),
  );
  await tx.commit();

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  return charm;
}

export function getDefaultRecipe(
  charms: CharmController[],
): CharmController | undefined {
  return charms.find((c) => {
    const name = c.name();
    return name && name.startsWith(DEFAULT_CHARM_NAME);
  });
}
