export type Domain = string; // `fab.space`, `alice.fab.space`
export type DidKey = `did:key:${string}`;
export type Namespace = Domain | DidKey;
export type SpaceName = string | DidKey;
export type CharmName = string | DidKey;

export type AddrComponent = {
  name: string;
  did: undefined;
} | {
  name: undefined;
  did: DidKey;
};

export type CharmAddress = {
  namespace?: AddrComponent;
  space?: AddrComponent;
  charm?: AddrComponent;
};

class CharmAddressError extends Error {
  constructor(message?: string) {
    super(message ?? "Invalid address.");
  }
}

export function parseCharmAddress(url: URL): CharmAddress {
  const [prefix, ns, space, charm] = url.pathname.split("/");
  if (prefix || !ns) throw new CharmAddressError();
  if (!space && charm) throw new CharmAddressError();
  // First component has `@`, this is a namespace
  if (ns.startsWith("@")) {
    return {
      namespace: newAddrComponent(ns.substring(1)),
      space: space ? newAddrComponent(space) : undefined,
      charm: charm ? newAddrComponent(charm) : undefined,
    };
  }
  // First component does not have `@`, this is a shared
  // space global to the provider.
  return {
    namespace: undefined,
    space: newAddrComponent(ns),
    charm: space ? newAddrComponent(space) : undefined,
  };
}

export function parseCharmAddressFromString(url: string): CharmAddress {
  return parseCharmAddress(new URL(url));
}

export function isDidKey(value: unknown): value is DidKey {
  return typeof value === "string" && value.startsWith("did:key:") &&
    value.length === 56;
}

export function newAddrComponent(value: unknown) {
  if (typeof value !== "string" || value === "") throw new CharmAddressError();
  if (isDidKey(value)) {
    return { did: value, name: undefined };
  }
  // Throw if valid resembles a did:key: without being one
  if (value.startsWith("did:key:")) throw new CharmAddressError();
  return { did: undefined, name: value };
}
