import { isRecord } from "@commontools/utils/types";

export type SandboxValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | object
  | Array<SandboxValue>;

export type GuestMessage = {
  type: "error";
  error: string;
} | {
  type: "console";
  method: string;
  args: unknown[];
};

export type HostMessage = {
  type: "invoke";
  export: string;
};

export function isGuestMessage(value: unknown): value is GuestMessage {
  if (
    !isRecord(value) || !("type" in value) || typeof value.type !== "string"
  ) {
    return false;
  }

  return value.type === "console"
    ? typeof value.method === "string" && Array.isArray(value.args)
    : value.type === "error"
    ? typeof value.error === "string"
    : false;
}
