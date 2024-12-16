import { $ } from "@commontools/common-system";
import { refer } from "merkle-reference";

interface ScalarType {
  type: "string" | "integer" | "float" | "boolean" | "bytes" | "entity";
}

abstract class Fact {
  abstract assert(value: any): Generator<never, void, unknown>;
  abstract match(): void;
}

abstract class Builder {
  abstract build(namespace: string[]): Fact;
}

class ScalarBuilder extends Builder {
  private type: ScalarType;
  constructor(type: ScalarType) {
    super();
    this.type = type;
  }

  override build(namespace: string[]): Scalar {
    return new Scalar(namespace, this.type);
  }
}

class Scalar extends Fact {
  private namespace: string[];
  private type: ScalarType;

  constructor(namespace: string[], type: ScalarType) {
    super();
    this.namespace = namespace;
    this.type = type;
  }

  override *assert(value: any): Generator<never, any, unknown> {
    if (typeof value === this.type.type) {
      return value;
    } else if (this.type.type === "entity" && entity.is(value)) {
      return value;
    } else if (this.type.type === "bytes" && Bytes.is(value)) {
      return value;
    } else {
      throw new TypeError(`Expected ${this.type.type}, got ${typeof value}`);
    }
  }

  override match({ this: self }: { this: any }): { Match: any[] } {
    return { Match: [self, "data/type", this.type.type] };
  }
}

export const string = () =>
  new ScalarBuilder({
    type: "string",
  });

export const integer = () =>
  new ScalarBuilder({
    type: "integer",
  });

export const boolean = () =>
  new ScalarBuilder({
    type: "boolean",
  });

export const bytes = () =>
  new ScalarBuilder({
    type: "bytes",
  });

export const entity = () =>
  new ScalarBuilder({
    type: "entity",
  });

export const embed = (form: Record<string, ScalarBuilder>) =>
  new EmbedBuilder(form);

class EmbedBuilder extends Builder {
  private form: Record<string, ScalarBuilder>;

  constructor(form: Record<string, ScalarBuilder>) {
    super();
    this.form = form;
  }

  override build(namespace: string[]): Embed {
    const form = Object.fromEntries(
      Object.entries(this.form).map(([key, value]) => [
        key,
        value.build([key]),
      ]),
    );

    return new Embed(namespace, form);
  }
}

class Embed extends Fact {
  private form: Record<string, Scalar>;
  private namespace: string[];

  constructor(namespace: string[], form: Record<string, Scalar>) {
    super();
    this.form = form;
    this.namespace = namespace;
  }

  override *assert(input: any): Generator<never, Record<string, any>, unknown> {
    const output: Record<string, any> = {};
    for (const [key, member] of Object.entries(this.form)) {
      const value = yield* member.assert(input[key]);
      output[key] = value;
    }
    return output;
  }

  override match({ this: self }: { this: any }): { Match: any[] } {
    return { Match: [self, "data/type", "embed"] };
  }
}

class RelationBuilder extends Builder {
  private form: Record<string, Builder>;

  constructor(form: Record<string, Builder>) {
    super();
    this.form = form;
  }

  override build(namespace: string[]): Relation {
    return new Relation(namespace, this.form);
  }
}

class Relation extends Fact {
  private namespace: string[];
  private form: Record<string, Builder>;

  constructor(namespace: string[], form: Record<string, Builder>) {
    super();
    this.namespace = namespace;
    this.form = form;
  }

  override *assert(data: any): Generator<any, void, unknown> {
    const entity = data.this ?? refer(data);
    for (const [key, member] of Object.entries(this.form)) {
      yield {
        Assert: [
          entity,
          [...this.namespace, key].join("/"),
          yield* (member as any).assert(data[key]),
        ],
      };
    }
  }

  override match(terms: any): { And: any[] } {
    const conjuncts: any[] = [];
    const entity = terms.this ?? $;
    for (const [key, term] of Object.entries(terms)) {
      const member = this.form[key];
      conjuncts.push((member as any).match({ this: term }));
      conjuncts.push({
        Case: [entity, [...this.namespace, key].join("/"), term],
      });
    }

    return { And: conjuncts };
  }
}

export const relation = (form: Record<string, Builder>) =>
  new RelationBuilder(form);

export const create = (form: Record<string, Builder>) =>
  Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, value.build([key])]),
  );
