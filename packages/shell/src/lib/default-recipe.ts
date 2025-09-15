import { CharmController, CharmsController } from "@commontools/charm/ops";
import { processSchema } from "@commontools/charm";
import { HttpProgramResolver } from "@commontools/js-runtime";
import { API_URL } from "./env.ts";

const ALL_CHARMS_ID =
  "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";
const DEFAULT_CHARM_NAME = "DefaultCharmList";

const DEFAULT_APP_URL = `${API_URL}api/patterns/default-app.tsx`;

export async function create(cc: CharmsController): Promise<CharmController> {
  const manager = cc.manager();
  const runtime = manager.runtime;

  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(DEFAULT_APP_URL),
  );

  const charm = await cc.create(program);

  const allCharmsCell = await manager.getCellById({ "/": ALL_CHARMS_ID });

  await runtime.editWithRetry((tx) => {
    const charmCell = charm.getCell();
    const sourceCell = charmCell.getSourceCell(processSchema);

    if (!sourceCell) {
      // Not sure how/when this happens
      throw new Error("Could not create and link default recipe.");
    }

    // Get the well-known allCharms cell using its EntityId format
    sourceCell.withTx(tx).key("argument").key("allCharms").set(
      allCharmsCell.withTx(tx),
    );
  });

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
