export enum CommandType {
  New,
  Extend,
  Other,
}
export type Command = {
  type: CommandType.New;
  prompt: string;
} | {
  type: CommandType.Other;
  prompt: string;
} | {
  type: CommandType.Extend;
  prompt: string;
};
