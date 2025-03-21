export enum CommandType {
  New,
  Other,
}
export type Command = {
  type: CommandType.New;
  prompt: string;
} | {
  type: CommandType.Other;
  prompt: string;
};
