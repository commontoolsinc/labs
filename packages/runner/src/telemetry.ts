// RuntimeTelemetry is used throughout the runtime
// to record events that can be subscribed to in other
// contexts to visualize or log events inside the runtime.

import { IMemoryChange } from "./storage/interface.ts";
import {
  Action,
  AnnotatedAction,
  AnnotatedEventHandler,
  EventHandler,
} from "./scheduler.ts";

// Types of markers that can be submitted by the runtime.
export type RuntimeTelemetryMarker = {
  type: "scheduler.run";
  action: Action | AnnotatedAction;
  error?: string;
} | {
  type: "cell.update";
  change: IMemoryChange;
  error?: string;
} | {
  type: "scheduler.invocation";
  handler: EventHandler | AnnotatedEventHandler;
  error?: string;
} | {
  type: "storage.push.start";
  id: string;
  operation: string;
} | {
  type: "storage.push.complete";
  id: string;
  success: boolean;
} | {
  type: "storage.push.error";
  id: string;
  error: string;
} | {
  type: "storage.pull.start";
  id: string;
  operation: string;
} | {
  type: "storage.pull.complete";
  id: string;
  success: boolean;
} | {
  type: "storage.pull.error";
  id: string;
  error: string;
} | {
  type: "storage.connection.update";
  status: "pending" | "ok" | "error";
  attempt: number;
} | {
  type: "storage.subscription.add";
  id: string;
} | {
  type: "storage.subscription.remove";
  id: string;
};

export type RuntimeTelemetryMarkerResult = RuntimeTelemetryMarker & {
  timeStamp: number;
};

export class RuntimeTelemetryEvent
  extends CustomEvent<{ marker: RuntimeTelemetryMarker }> {
  readonly marker: RuntimeTelemetryMarkerResult;

  constructor(marker: RuntimeTelemetryMarker) {
    super("telemetry", {
      detail: {
        marker,
      },
    });
    this.marker = { ...marker, timeStamp: this.timeStamp };
  }
}

export class RuntimeTelemetry extends EventTarget {
  submit(marker: RuntimeTelemetryMarker) {
    this.dispatchEvent(new RuntimeTelemetryEvent(marker));
  }
}
