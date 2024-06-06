import { Lattice } from "./lattice.ts";

export class Principal {
  join(other: Principal, lattice: Lattice): Principal {
    const thisParents = lattice.up.get(this) || [this];
    const otherParents = lattice.up.get(other) || [other];
    const firstCommonParent = thisParents.find((p) => otherParents.includes(p));
    return firstCommonParent ?? TOP;
  }

  equals(other: Principal): boolean {
    return this.toString() === other.toString();
  }

  toJSON() {
    return { type: "Principal" };
  }

  toString() {
    return JSON.stringify(this);
  }
}

/**
 * This represents concepts of any of the below. The lattice will map from
 * concepts to these principals.
 */
export class Concept extends Principal {
  constructor(public readonly url: string) {
    super();
  }

  // Resolve to concrete principals via the lattice. Returns first concrete
  // principal walking up the lattice, or the last concept on any branch if
  // there aren't any.
  resolve(lattice: Lattice): Principal[] {
    const up = lattice.concepts.get(this.toString());
    if (!up || up.length === 0) return [this];
    return up.flatMap((p) => (p instanceof Concept ? p.resolve(lattice) : p));
  }

  toJSON() {
    return { type: "Concept", url: this.url };
  }
}

export const BOTTOM = new Concept("BOTTOM");
export const TOP = new Concept("TOP");

export function dedupe(principals: Principal[]): Principal[] {
  const deduped: Principal[] = [];
  for (const p of principals) {
    if (!deduped.some((d) => d.equals(p))) {
      deduped.push(p);
    }
  }
  return deduped;
}

/**
 * Support composite principals, e.g.
 *   const module = new ModuleOutput("0xcoffee");
 *   const user = new User();
 *   const composite = new CompositePrincipal(module, { user });
 */
export type Parameter = Principal | Parameter[] | { [key: string]: Parameter };

export class Composite<T extends Principal> extends Principal {
  constructor(
    public readonly generic: T,
    public readonly parameters: { [key: string]: Parameter } = {}
  ) {
    super();
  }

  toJSON() {
    return {
      type: "Composite",
      generic: this.generic,
      parameters: this.parameters,
    };
  }
}

export class Expression extends Principal {
  toJSON() {
    return { type: "Expression" };
  }
}

export class JoinExpression<
  T extends Principal = Principal
> extends Expression {
  constructor(public readonly principals: T[]) {
    super();
  }

  join(other: Principal, lattice: Lattice): Principal {
    let principals = [];
    if (other instanceof Expression && !(other instanceof JoinExpression)) {
      // Other expressions will either return a new simplified joined version,
      // or a JoinExpression if it can't be simplified. So we map over all
      // principals and then flatten out the returned joins again. The next step
      // will dedupe the redundancy out again.
      principals = this.principals
        .map((p) => other.join(p, lattice))
        .flatMap((p) => (p instanceof JoinExpression ? p.principals : [p]));
    } else if (other instanceof JoinExpression) {
      // Flatten out two joins
      principals = [...this.principals, other.principals];
    } else {
      principals = [...this.principals, other];
    }

    principals =
      other instanceof JoinExpression
        ? [...this.principals, ...other.principals]
        : [...this.principals, other];

    // dedupe principals, using .equals
    const deduped: T[] = [];
    for (const p of principals) {
      if (!deduped.some((d) => d.equals(p))) {
        deduped.push(p);
      }
    }

    return new JoinExpression<T>(deduped);
  }

  toJSON() {
    return { type: "JoinExpression", principals: this.principals };
  }
}

/**
 * Principals that captures integrity of data
 */
export class Integrity extends Principal {
  toJSON() {
    return { type: "Integrity" };
  }
}

/**
 * Example of a custom lattice that kicks in when the lattice has no opinion
 * otherwise.
 */
export class URLPrincipal extends Integrity {
  constructor(public readonly url: string) {
    super();
  }

  join(other: Principal, lattice: Lattice): Principal {
    const result = super.join(other, lattice);
    if (result === TOP && other instanceof URLPrincipal) {
      // For now: Substring of the other is higher in the lattice
      if (this.url.startsWith(other.url)) return other;
      if (other.url.startsWith(this.url)) return this;
    }
    return result;
  }

  toJSON() {
    return { type: "URLPrincipal", url: this.url };
  }
}

export class Const extends Integrity {
  constructor(public readonly hash: string) {
    super();
  }

  toJSON() {
    return { type: "Const", hash: this.hash };
  }
}

export class Data extends Integrity {
  toJSON() {
    return { type: "Data" };
  }
}

export class Module extends Principal {
  constructor(public readonly hash: string) {
    super();
  }

  toJSON() {
    return { type: "Module", hash: this.hash };
  }
}

export class ModuleOutput extends Integrity {
  constructor(hash: string, inputs: { [key: string]: Integrity }) {
    super();
    return new Composite(new Module(hash), inputs);
  }
}

/**
 * Principals that capture confidentiality of data
 */
export class Confidentiality extends Principal {
  toJSON() {
    return { type: "Confidentiality" };
  }
}

export class Capability extends Confidentiality {
  toJSON() {
    return { type: "Capability" };
  }
}

export class NetworkCapability extends Capability {
  constructor(public readonly url: URLPrincipal) {
    super();
  }

  join(other: Principal, lattice: Lattice): Principal {
    if (!(other instanceof NetworkCapability))
      return super.join(other, lattice);
    const join = other.url.join(this.url, lattice);
    if (join === TOP) return TOP;
    return new NetworkCapability(join as URLPrincipal);
  }

  toJSON() {
    return { type: "NetworkCapability", url: this.url };
  }
}

export class User extends Confidentiality {
  // TBD, for multi-user scenarios

  toJSON() {
    return { type: "User" };
  }
}

export class Environment extends Confidentiality {
  // Should eventually cover specific devices, confidential compute, etc.
  // and runtime versions
  constructor(public readonly name: string) {
    super();
  }

  toJSON() {
    return { type: "Environment", name: this.name };
  }
}
