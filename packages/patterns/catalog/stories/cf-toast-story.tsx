import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ToastStoryInput {}
interface ToastStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToastStoryInput, ToastStoryOutput>(() => {
  const showDefault = Writable.of(false);
  const showSuccess = Writable.of(false);
  const showError = Writable.of(false);
  const showWarning = Writable.of(false);
  const showAction = Writable.of(false);

  return {
    [NAME]: "cf-toast Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-vstack gap="3">
          <cf-heading level={5}>Toast Variants</cf-heading>
          <cf-hstack gap="2">
            <cf-button
              variant="secondary"
              onClick={action(() => showDefault.set(true))}
            >
              Default
            </cf-button>
            <cf-button
              variant="secondary"
              onClick={action(() => showSuccess.set(true))}
            >
              Success
            </cf-button>
            <cf-button
              variant="secondary"
              onClick={action(() => showError.set(true))}
            >
              Error
            </cf-button>
            <cf-button
              variant="secondary"
              onClick={action(() => showWarning.set(true))}
            >
              Warning
            </cf-button>
            <cf-button
              variant="primary"
              onClick={action(() => showAction.set(true))}
            >
              With Action
            </cf-button>
          </cf-hstack>
        </cf-vstack>

        <cf-toast-provider position="bottom">
          <cf-toast
            open={showDefault}
            variant="default"
            duration={4000}
            oncf-toast-dismiss={action(() => showDefault.set(false))}
          >
            This is a default notification.
          </cf-toast>
          <cf-toast
            open={showSuccess}
            variant="success"
            duration={4000}
            oncf-toast-dismiss={action(() => showSuccess.set(false))}
          >
            Changes saved successfully.
          </cf-toast>
          <cf-toast
            open={showError}
            variant="error"
            duration={0}
            dismissible
            oncf-toast-dismiss={action(() => showError.set(false))}
          >
            Connection lost. Retrying...
          </cf-toast>
          <cf-toast
            open={showWarning}
            variant="warning"
            duration={4000}
            oncf-toast-dismiss={action(() => showWarning.set(false))}
          >
            Storage almost full.
          </cf-toast>
          <cf-toast
            open={showAction}
            variant="success"
            duration={5000}
            oncf-toast-dismiss={action(() => showAction.set(false))}
          >
            Wish sent.
            <cf-button
              slot="action"
              variant="secondary"
              size="sm"
            >
              View
            </cf-button>
          </cf-toast>
        </cf-toast-provider>
      </div>
    ),
    controls: <></>,
  };
});
