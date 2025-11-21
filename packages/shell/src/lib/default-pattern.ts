import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";

const DEFAULT_CHARM_NAME = "DefaultCharmList";
const DEFAULT_APP_URL = `${API_URL}api/patterns/default-app.tsx`;

export async function create(cc: CharmsController): Promise<CharmController> {
  const manager = cc.manager();
  const runtime = manager.runtime;

  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(DEFAULT_APP_URL),
  );

  const charm = await cc.create(program, undefined, "default-charm");

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  // Link the default pattern to the space cell
  await manager.linkDefaultPattern(charm.getCell());

  return charm;
}

export function getDefaultPattern(
  charms: CharmController[],
): CharmController | undefined {
  return charms.find((c) => {
    const name = c.name();
    return name && name.startsWith(DEFAULT_CHARM_NAME);
  });
}
