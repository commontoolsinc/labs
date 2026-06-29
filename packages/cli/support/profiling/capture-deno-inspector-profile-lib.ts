export type ProfileCaptureState = {
  consoleMessages: string[];
  profilerActive: boolean;
  sawProfileStart: boolean;
  sawProfileStop: boolean;
};

export function recordConsoleProfileMessage(
  state: ProfileCaptureState,
  text: string,
  profileStartRegex?: RegExp,
  profileStopRegex?: RegExp,
): void {
  state.consoleMessages.push(text);
  if (profileStartRegex?.test(text)) {
    state.sawProfileStart = true;
  }
  if (profileStopRegex?.test(text)) {
    state.sawProfileStop = true;
  }
}

export function markProfilerStarted(state: ProfileCaptureState): void {
  state.profilerActive = true;
  state.sawProfileStop = false;
}
