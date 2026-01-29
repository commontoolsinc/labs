/// <cts-enable />
/**
 * Text Swapper
 *
 * Simple pattern with two text labels and a swap button between them.
 * Click on either label to rename it via modal.
 */
import { Default, handler, pattern, UI, Writable } from "commontools";

// ============ TYPES ============

type EditingSide = "left" | "right" | null;

interface Input {
  leftText: Writable<Default<string, "Hello">>;
  rightText: Writable<Default<string, "World">>;
}

interface Output {
  leftText: string;
  rightText: string;
}

// ============ HANDLERS ============

const swapTexts = handler<
  unknown,
  { leftText: Writable<string>; rightText: Writable<string> }
  >((_event, { leftText, rightText }) => {
  const left = leftText.get();
  const right = rightText.get();
  console.log("swapTexts", { left, right });
  leftText.set(right);
  rightText.set(left);
});

const openEditLeft = handler<
  unknown,
  {
    leftText: Writable<string>;
    editingSide: Writable<EditingSide>;
    editValue: Writable<string>;
    showModal: Writable<boolean>;
  }
  >((_event, { leftText, editingSide, editValue, showModal }) => {
  console.log("openEditLeft");
  editingSide.set("left");
  editValue.set(leftText.get());
  showModal.set(true);
});

const openEditRight = handler<
  unknown,
  {
    rightText: Writable<string>;
    editingSide: Writable<EditingSide>;
    editValue: Writable<string>;
    showModal: Writable<boolean>;
  }
  >((_event, { rightText, editingSide, editValue, showModal }) => {
  console.log("openEditRight");
  editingSide.set("right");
  editValue.set(rightText.get());
  showModal.set(true);
});

const saveEdit = handler<
  unknown,
  {
    leftText: Writable<string>;
    rightText: Writable<string>;
    editingSide: Writable<EditingSide>;
    editValue: Writable<string>;
    showModal: Writable<boolean>;
  }
>((_event, { leftText, rightText, editingSide, editValue, showModal }) => {
  const side = editingSide.get();
  const value = editValue.get();

  console.log("saveEdit", { side, value });
  if (side === "left") {
    leftText.set(value);
  } else if (side === "right") {
    rightText.set(value);
  }

  showModal.set(false);
  editingSide.set(null);
  editValue.set("");
});

const closeModal = handler<
  unknown,
  {
    editingSide: Writable<EditingSide>;
    editValue: Writable<string>;
    showModal: Writable<boolean>;
  }
>((_event, { editingSide, editValue, showModal }) => {
  console.log("closeModal");
  showModal.set(false);
  editingSide.set(null);
  editValue.set("");
});

// ============ PATTERN ============

export default pattern<Input, Output>(({ leftText, rightText }) => {
  // Modal state
  const showModal = Writable.of<boolean>(false);
  const editingSide = Writable.of<EditingSide>(null);
  const editValue = Writable.of<string>("");

  const labelStyle = {
    padding: "12px 24px",
    backgroundColor: "#f3f4f6",
    borderRadius: "8px",
    fontSize: "1.25rem",
    minWidth: "100px",
    textAlign: "center",
    cursor: "pointer",
  };

  return {
    leftText,
    rightText,
    [UI]: (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          padding: "24px",
        }}
      >
        <div
          style={labelStyle}
          onClick={openEditLeft({
            leftText,
            editingSide,
            editValue,
            showModal,
          })}
        >
          {leftText}
        </div>

        <ct-button onClick={swapTexts({ leftText, rightText })}>
          ⇄ Swap
        </ct-button>

        <div
          style={labelStyle}
          onClick={openEditRight({
            rightText,
            editingSide,
            editValue,
            showModal,
          })}
        >
          {rightText}
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showModal} dismissable size="sm" label="Edit Text">
          <span slot="header">
            Edit {editingSide.get() === "left" ? "Left" : "Right"} Text
          </span>

          <div>
            <label
              style={{
                fontSize: "0.75rem",
                fontWeight: "500",
                display: "block",
                marginBottom: "4px",
              }}
            >
              Text
            </label>
            <ct-input
              $value={editValue}
              placeholder="Enter text..."
              style="width: 100%;"
            />
          </div>

          <div
            slot="footer"
            style={{
              display: "flex",
              gap: "8px",
              justifyContent: "flex-end",
              width: "100%",
            }}
          >
            <button
              type="button"
              style={{
                padding: "6px 12px",
                fontSize: "0.875rem",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                backgroundColor: "#fff",
                cursor: "pointer",
              }}
              onClick={closeModal({ editingSide, editValue, showModal })}
            >
              Cancel
            </button>
            <button
              type="button"
              style={{
                padding: "6px 12px",
                fontSize: "0.875rem",
                border: "none",
                borderRadius: "6px",
                backgroundColor: "#3b82f6",
                color: "#fff",
                cursor: "pointer",
              }}
              onClick={saveEdit({
                leftText,
                rightText,
                editingSide,
                editValue,
                showModal,
              })}
            >
              Save
            </button>
          </div>
        </ct-modal>
      </div>
    ),
  };
});
