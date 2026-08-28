export interface CheckinSubmission {
  id: string;
  mood: string;
  message: string;
}

export interface IframeInputData {
  question: string;
  moods: string[];
}

export interface IframeStateData {
  mood: string;
  message: string;
  pendingSubmissionId?: string | null;
}

export interface IframeOutputData {
  submissions: CheckinSubmission[];
}

export const DEFAULT_INPUT: IframeInputData = {
  question: "What should the room know before we start?",
  moods: ["Focused", "Curious", "Blocked", "Energized"],
};

export const DEFAULT_STATE: IframeStateData = {
  mood: "Focused",
  message: "",
  pendingSubmissionId: null,
};

export const DEFAULT_OUTPUT: IframeOutputData = { submissions: [] };

export const IFRAME_PATTERN = {
  name: "IframeSessionCheckin",
  displayName: "Iframe · Session check-in",
  stateScope: "session",
  outputScope: "space",
  frameHeight: "720px",
  databases: {},
} as const;
