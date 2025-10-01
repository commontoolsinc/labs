/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface RenderTreeArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface AdjustContext {
  value: Cell<number>;
  step: Cell<number>;
  direction: Cell<number>;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustContext,
  ) => {
    const direction = context.direction.get() ?? 1;
    const stepValue = context.step.get();
    const fallback = typeof stepValue === "number" && stepValue !== 0
      ? stepValue
      : 1;
    const amount = typeof event?.amount === "number" ? event.amount : fallback;
    const current = context.value.get() ?? 0;
    context.value.set(current + direction * amount);
  },
);

const normalizeNumber = (input: number | undefined, fallback: number) => {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
};

export const counterWithRenderTreeUx = recipe<RenderTreeArgs>(
  "Counter With Render Tree (UX)",
  ({ value, step }) => {
    const safeStep = lift((raw: number | undefined) => normalizeNumber(raw, 1))(
      step,
    );
    const safeValue = lift((raw: number | undefined) =>
      normalizeNumber(raw, 0)
    )(value);

    const increment = adjustValue({
      value,
      step: safeStep,
      direction: cell(1),
    });
    const decrement = adjustValue({
      value,
      step: safeStep,
      direction: cell(-1),
    });

    const heading = str`Value ${safeValue}`;
    const description = str`Step size ${safeStep}`;
    const incrementLabel = str`Add ${safeStep}`;
    const decrementLabel = str`Subtract ${safeStep}`;

    const renderTree = {
      type: "counter-view",
      header: { text: heading },
      body: {
        description,
        controls: {
          increase: {
            kind: "button",
            label: incrementLabel,
            onPress: increment,
          },
          decrease: {
            kind: "button",
            label: decrementLabel,
            onPress: decrement,
          },
        },
      },
    };

    const name = str`Counter with Render Tree (${safeValue})`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    color: #6366f1;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Declarative UI Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                  ">
                  Counter with Render Tree
                </h2>
                <p style="
                    margin: 0;
                    color: #64748b;
                    font-size: 0.95rem;
                    line-height: 1.5;
                  ">
                  This pattern demonstrates exposing a structured render tree
                  that describes the UI declaratively. The tree defines the
                  component structure, labels, and event handlers in a portable
                  format.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 1rem;
                  padding: 2rem;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  gap: 1rem;
                ">
                <div style="
                    text-align: center;
                    color: white;
                  ">
                  <div style="
                      font-size: 0.85rem;
                      opacity: 0.9;
                      margin-bottom: 0.25rem;
                    ">
                    Current Value
                  </div>
                  <div style="
                      font-size: 3.5rem;
                      font-weight: 700;
                      line-height: 1;
                    ">
                    {safeValue}
                  </div>
                </div>

                <div style="
                    display: flex;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                    justify-content: center;
                  ">
                  <ct-button
                    onClick={increment}
                    style="
                      background: rgba(255, 255, 255, 0.95);
                      color: #667eea;
                      border: none;
                      padding: 0.75rem 1.5rem;
                      font-weight: 600;
                      font-size: 0.95rem;
                      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    "
                    aria-label={incrementLabel}
                  >
                    {incrementLabel}
                  </ct-button>
                  <ct-button
                    onClick={decrement}
                    style="
                      background: rgba(255, 255, 255, 0.2);
                      color: white;
                      border: 1px solid rgba(255, 255, 255, 0.3);
                      padding: 0.75rem 1.5rem;
                      font-weight: 600;
                      font-size: 0.95rem;
                    "
                    aria-label={decrementLabel}
                  >
                    {decrementLabel}
                  </ct-button>
                </div>

                <div style="
                    text-align: center;
                    color: rgba(255, 255, 255, 0.9);
                    font-size: 0.85rem;
                    margin-top: 0.5rem;
                  ">
                  {description}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="font-size: 1.25rem;">📋</span>
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Render Tree Structure
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <p style="
                  margin: 0;
                  color: #64748b;
                  font-size: 0.9rem;
                  line-height: 1.6;
                ">
                The{" "}
                <code style="
                  background: #f1f5f9;
                  padding: 0.15rem 0.4rem;
                  border-radius: 0.25rem;
                  font-family: monospace;
                  font-size: 0.85em;
                ">
                  renderTree
                </code>{" "}
                output exposes the UI structure as a plain object. This enables
                rendering the same logic across different platforms or creating
                visual builders.
              </p>

              <div style="
                  background: #f8fafc;
                  border: 1px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-family: monospace;
                  font-size: 0.85rem;
                  line-height: 1.6;
                  overflow-x: auto;
                ">
                <div style="color: #64748b;">
                  type: <span style="color: #0ea5e9;">"counter-view"</span>
                </div>
                <div style="color: #64748b; margin-left: 0;">
                  header:
                </div>
                <div style="color: #64748b; margin-left: 1rem;">
                  text: <span style="color: #10b981;">"{heading}"</span>
                </div>
                <div style="color: #64748b; margin-left: 0;">
                  body:
                </div>
                <div style="color: #64748b; margin-left: 1rem;">
                  description:{" "}
                  <span style="color: #10b981;">
                    "{description}"
                  </span>
                </div>
                <div style="color: #64748b; margin-left: 1rem;">
                  controls:
                </div>
                <div style="color: #64748b; margin-left: 2rem;">
                  increase: &#123; kind: "button", label, onPress &#125;
                </div>
                <div style="color: #64748b; margin-left: 2rem;">
                  decrease: &#123; kind: "button", label, onPress &#125;
                </div>
              </div>

              <div style="
                  background: #eff6ff;
                  border-left: 3px solid #3b82f6;
                  padding: 0.75rem 1rem;
                  border-radius: 0.25rem;
                  font-size: 0.85rem;
                  color: #1e40af;
                ">
                💡 This declarative approach separates business logic from
                presentation, making the pattern testable and portable.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value,
      rawStep: step,
      step: safeStep,
      safeValue,
      heading,
      description,
      incrementLabel,
      decrementLabel,
      renderTree,
      controls: {
        increment,
        decrement,
      },
    };
  },
);

export default counterWithRenderTreeUx;
