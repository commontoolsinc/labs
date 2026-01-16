import { DID, KeyStore } from "@commontools/identity";
import { Command } from "./commands.ts";
import { AppState } from "./mod.ts";
import { PropertyDeclaration } from "lit";

export interface AppElement extends EventTarget {
  state(): AppState;
  apply(command: Command): Promise<void>;
  keyStore: KeyStore;
  requestUpdate(
    key: string | number | symbol,
    oldValue?: any,
    options?: PropertyDeclaration,
  ): void;
  getRuntimeSpaceDID(): DID | undefined;
}
