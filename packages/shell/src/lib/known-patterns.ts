import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";

const DEFAULT_CHARM_NAME = "DefaultCharmList";
const DEFAULT_APP_URL = `${API_URL}api/patterns/default-app.tsx`;
const PROFILE_CHARM_NAME = "Profile";
const PROFILE_APP_URL = `${API_URL}api/patterns/profile.tsx`;

export enum KnownPatternType {
  Default,
  Profile,
}

export async function create(
  cc: CharmsController,
  type: KnownPatternType,
): Promise<CharmController> {
  const manager = cc.manager();
  const runtime = manager.runtime;
  const url = type === KnownPatternType.Default
    ? DEFAULT_APP_URL
    : PROFILE_APP_URL;
  const cause = type === KnownPatternType.Default
    ? DEFAULT_CHARM_NAME
    : PROFILE_CHARM_NAME;
  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(url),
  );

  const charm = await cc.create(program, undefined, cause);

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  // Link the default pattern to the space cell
  await manager.linkDefaultPattern(charm.getCell());

  return charm;
}

export function getPattern(
  charms: CharmController[],
  type: KnownPatternType,
): CharmController | undefined {
  const patternName = type === KnownPatternType.Default
    ? DEFAULT_CHARM_NAME
    : PROFILE_CHARM_NAME;
  return charms.find((c) => {
    const name = c.name();
    return name && name.startsWith(patternName);
  });
}
