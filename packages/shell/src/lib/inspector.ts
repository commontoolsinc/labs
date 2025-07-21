import * as Inspector from "@commontools/runner/storage/inspector";

export class InspectorUpdateEvent
  extends CustomEvent<{ model: InspectorState }> {
  constructor(model: InspectorState) {
    super("inspectorupdate", {
      detail: {
        model,
      },
    });
  }
}

export type InspectorConflicts = {
  push: Inspector.PushStateValue[];
  pull: Inspector.PullStateValue[];
};

export class InspectorState extends Inspector.Model {
  constructor(time = Date.now()) {
    super(
      { pending: { ok: { attempt: 0 } }, time },
      {},
      {},
      {},
    );
  }

  update(command: Inspector.BroadcastCommand) {
    Inspector.update(this, command);
  }

  getErrors(): InspectorConflicts | undefined {
    const push = Object.values(this.push).filter(
      (v) => v.error,
    );
    const pull = Object.values(this.pull).filter(
      (v) => v.error,
    );

    if (push.length === 0 && pull.length === 0) {
      return;
    }
    return { push, pull };
  }
}
