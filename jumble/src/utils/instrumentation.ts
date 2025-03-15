export function reportState(key: string, value: any) {
  // Initialize if not exists
  if (!("_common" in globalThis)) {
    (globalThis as any)._common = { _instrumentedState: {} };
  } else if (!(globalThis as any)._common) {
    (globalThis as any)._common = { _instrumentedState: {} };
  } else if (!(globalThis as any)._common._instrumentedState) {
    (globalThis as any)._common._instrumentedState = {};
  }

  (globalThis as any)._common._instrumentedState[key] = value;
}

// Define types for the global object
declare global {
  interface Window {
    _common: {
      _instrumentedState: Record<string, any>;
    };
  }
}
