import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface AlertStoryInput {}
interface AlertStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<AlertStoryInput, AlertStoryOutput>(() => {
  const status = Writable.of<"info" | "success" | "warning" | "error">("info");
  const dismissible = Writable.of(false);
  const icon = Writable.of("i");
  const showIcon = Writable.of(true);
  const title = Writable.of("Alert title");
  const description = Writable.of("This is alert description text.");
  const body = Writable.of("");

  return {
    [NAME]: "cf-alert Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div style={{ padding: "2rem 0" }}>
          <cf-alert
            status={status}
            dismissible={dismissible}
          >
            {showIcon.get() ? <span slot="icon">{icon}</span> : null}
            <span slot="title">{title}</span>
            <span slot="description">{description}</span>
            {body}
          </cf-alert>
          <div
            style={{ fontSize: "0.875rem", color: "#6b7280", marginTop: "8px" }}
          >
            Dismissible alerts emit cf-dismiss when the close button is clicked.
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="status"
            description="Alert status"
            defaultValue="info"
            value={status}
            items={[
              { label: "Info", value: "info" },
              { label: "Success", value: "success" },
              { label: "Warning", value: "warning" },
              { label: "Error", value: "error" },
            ]}
          />
          <SwitchControl
            label="dismissible"
            description="Shows dismiss button and emits cf-dismiss"
            defaultValue="false"
            checked={dismissible}
          />
          <SwitchControl
            label="show icon"
            description="Renders icon slot content"
            defaultValue="true"
            checked={showIcon}
          />
          <TextControl
            label="icon"
            description="Icon slot text"
            defaultValue="i"
            value={icon}
          />
          <TextControl
            label="title"
            description="Title slot text"
            defaultValue="Alert title"
            value={title}
          />
          <TextControl
            label="description"
            description="Description slot text"
            defaultValue="This is alert description text."
            value={description}
          />
          <TextControl
            label="children"
            description="Default slot content"
            defaultValue=""
            value={body}
          />
        </>
      </Controls>
    ),
  };
});
