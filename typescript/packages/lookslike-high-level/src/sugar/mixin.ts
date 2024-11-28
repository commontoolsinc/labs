import { Behavior, Rule, Selector } from "@commontools/common-system";

// export const mixin = <T extends Behavior>(behavior: T) => behavior.rules
export const mixin = <T extends Behavior<Record<string, Rule<any>>>>(behavior: T) => behavior.rules;
