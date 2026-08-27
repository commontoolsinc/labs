export interface PrivateNote {
  id: string;
  text: string;
}

export interface SharedHighlight {
  id: string;
  text: string;
}

export interface IframeInputData {
  prompt: string;
}

export interface IframeStateData {
  notes: PrivateNote[];
}

export interface IframeOutputData {
  highlights: SharedHighlight[];
}

export const DEFAULT_INPUT: IframeInputData = {
  prompt: "Capture privately, then publish only what helps the group.",
};

export const DEFAULT_STATE: IframeStateData = {
  notes: [],
};

export const DEFAULT_OUTPUT: IframeOutputData = { highlights: [] };

export const IFRAME_PATTERN = {
  name: "IframeHighlightsExchange",
  displayName: "Iframe · Highlights exchange",
  stateScope: "user",
  outputScope: "space",
  frameHeight: "760px",
  databases: {},
} as const;
