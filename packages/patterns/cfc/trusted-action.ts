import { Cfc, WriteAuthorizedBy } from "commonfabric";

export type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action,
  Pattern,
  [Pattern]
>;

export type TrustedActionUiContract<
  T,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]] = [Pattern],
> = Cfc<
  T,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;
