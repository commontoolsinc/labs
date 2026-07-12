import {
  action,
  Default,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type NameCell = Writable<string | Default<"">>;

export interface ScopedNameHandoffInput {
  sharedName?: PerSpace<NameCell>;
  myName?: PerUser<NameCell>;
}

export interface ScopedNameHandoffOutput {
  [NAME]: string;
  [UI]: VNode;
  sharedName: PerSpace<string | Default<"">>;
  myName: PerUser<string | Default<"">>;
  publishName: Stream<void>;
}

export default pattern<ScopedNameHandoffInput, ScopedNameHandoffOutput>(
  ({ sharedName, myName }) => {
    const publishName = action(() => {
      sharedName.set(myName.get());
    });

    return {
      [NAME]: "Scoped name handoff",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>Scoped name handoff</cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1rem; max-width: 420px;">
            <cf-vstack gap="1">
              <cf-label>Your name</cf-label>
              <cf-input
                $value={myName}
                placeholder="Ada Lovelace"
                aria-label="Your name"
                timing-strategy="immediate"
              />
            </cf-vstack>

            <cf-vstack gap="1">
              <cf-label>Shared name</cf-label>
              <div>{sharedName}</div>
            </cf-vstack>

            <cf-button onClick={publishName}>Use my name</cf-button>
          </cf-vstack>
        </cf-screen>
      ),
      sharedName,
      myName,
      publishName,
    };
  },
);
