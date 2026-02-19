import { App } from "../shared/mod.ts";
import { type RuntimeClient } from "@commontools/runtime-client";

declare global {
  var app: App;
  var commontools: {
    rt?: RuntimeClient;
    [key: string]: unknown;
  };
}
