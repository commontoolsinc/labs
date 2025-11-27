import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";

export type BuiltinPatternType = "home" | "space-default";

type BuiltinPatternConfig = {
  url: URL;
  cause: string;
  name: string;
};

const Configs: Record<BuiltinPatternType, BuiltinPatternConfig> = {
  "home": {
    name: "Home",
    url: new URL(`/api/patterns/home.tsx`, API_URL),
    cause: "home-pattern",
  },
  "space-default": {
    name: "DefaultCharmList",
    url: new URL(`/api/patterns/default-app.tsx`, API_URL),
    cause: "default-charm",
  },
};

export async function create(
  cc: CharmsController,
  type: BuiltinPatternType,
): Promise<CharmController> {
  const config = Configs[type];
  const manager = cc.manager();
  const runtime = manager.runtime;

  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(config.url.href),
  );

  const charm = await cc.create(program, { start: true }, config.cause);

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  // Link the default pattern to the space cell
  await manager.linkDefaultPattern(charm.getCell());

  return charm;
}

export async function get(
  cc: CharmsController,
): Promise<CharmController | undefined> {
  const pattern = await cc.manager().getDefaultPattern();
  if (!pattern) {
    return undefined;
  }
  return new CharmController(cc.manager(), pattern);
}

export async function getOrCreate(
  cc: CharmsController,
  type: BuiltinPatternType,
): Promise<CharmController> {
  const pattern = await get(cc);
  if (pattern) {
    return pattern;
  }
  return await create(cc, type);
}
