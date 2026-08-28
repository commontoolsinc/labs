export interface PollOption {
  id: string;
  label: string;
}

export interface IframeInputData {
  question: string;
  options: PollOption[];
}

export interface IframeStateData {
  ballots?: Record<string, string>;
}

export type IframeOutputData = Record<never, never>;

export const DEFAULT_INPUT: IframeInputData = {
  question: "Where should the team work together next?",
  options: [
    { id: "studio", label: "Design studio" },
    { id: "library", label: "Library" },
    { id: "garden", label: "Garden" },
  ],
};

export const DEFAULT_STATE: IframeStateData = { ballots: {} };

export const DEFAULT_OUTPUT: IframeOutputData = {};

export const IFRAME_PATTERN = {
  name: "IframeTeamPoll",
  displayName: "Iframe · Team poll",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "680px",
  databases: {},
} as const;
