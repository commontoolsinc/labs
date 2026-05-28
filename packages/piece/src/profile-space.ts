import type { DID, Identity } from "@commonfabric/identity";

export const PROFILE_SPACE_DERIVATION_NAME = "common-fabric-profile";

export const deriveProfileSpaceDID = async (
  identity: Identity,
): Promise<DID> => {
  const profileIdentity = await identity.derive(PROFILE_SPACE_DERIVATION_NAME);
  return profileIdentity.did();
};
