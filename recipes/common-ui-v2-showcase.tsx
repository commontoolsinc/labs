import { h, NAME, recipe, schema, str, UI } from "commontools";

const model = schema({
  type: "object",
  properties: {},
  default: {},
});

export default recipe(model, model, () => {
  return {
    [NAME]: str`Common UI v2 Components Showcase`,
    [UI]: (
      <div style="max-width: 1200px; margin: 0 auto; padding: 2rem;">
        <h1 style="text-align: center; margin-bottom: 3rem;">
          Common UI v2 Components Showcase
        </h1>

        {/* Button Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>1. Button Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Various button styles and sizes
          </p>

          <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <ct-button>Default</ct-button>
            <ct-button variant="secondary">Secondary</ct-button>
            <ct-button variant="destructive">Destructive</ct-button>
            <ct-button variant="outline">Outline</ct-button>
            <ct-button variant="ghost">Ghost</ct-button>
            <ct-button variant="link">Link</ct-button>
          </div>

          <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
            <ct-button size="sm">Small</ct-button>
            <ct-button>Default Size</ct-button>
            <ct-button size="lg">Large</ct-button>
            <ct-button size="icon">🎯</ct-button>
            <ct-button disabled>Disabled</ct-button>
          </div>
        </section>

        {/* Input Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>2. Input Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Various input types and states
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem;">
            <div>
              <ct-label for="text-input">Text Input</ct-label>
              <ct-input
                id="text-input"
                type="text"
                placeholder="Enter text..."
              >
              </ct-input>
            </div>

            <div>
              <ct-label for="email-input" required>Email Input</ct-label>
              <ct-input
                id="email-input"
                type="email"
                placeholder="you@example.com"
              >
              </ct-input>
            </div>

            <div>
              <ct-label for="password-input">Password Input</ct-label>
              <ct-input
                id="password-input"
                type="password"
                placeholder="Enter password..."
              >
              </ct-input>
            </div>

            <div>
              <ct-label for="number-input">Number Input</ct-label>
              <ct-input
                id="number-input"
                type="number"
                placeholder="0"
                min="0"
                max="100"
              >
              </ct-input>
            </div>
          </div>
        </section>

        {/* Textarea Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>3. Textarea Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Text areas with different configurations
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;">
            <div>
              <ct-label for="basic-textarea">Basic Textarea</ct-label>
              <ct-textarea
                id="basic-textarea"
                placeholder="Enter your message..."
                rows="4"
              >
              </ct-textarea>
            </div>

            <div>
              <ct-label for="auto-textarea">Auto-resize Textarea</ct-label>
              <ct-textarea
                id="auto-textarea"
                placeholder="This grows as you type..."
                auto-resize
                rows="2"
              >
              </ct-textarea>
            </div>
          </div>
        </section>

        {/* Card Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>4. Card Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Card layouts and styles
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;">
            <ct-card>
              <div slot="header">
                <h3>Card Title</h3>
                <p>Card description goes here</p>
              </div>
              <div slot="content">
                <p>
                  This is the card content. Cards can contain any type of
                  content.
                </p>
              </div>
              <div slot="footer">
                <ct-button size="sm">Action</ct-button>
              </div>
            </ct-card>

            <ct-card>
              <div slot="content">
                <h3>Simple Card</h3>
                <p>Cards don't require all slots to be filled.</p>
              </div>
            </ct-card>
          </div>
        </section>

        {/* Badge Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>5. Badge Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Badge variations</p>

          <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
            <ct-badge>Default</ct-badge>
            <ct-badge variant="secondary">Secondary</ct-badge>
            <ct-badge variant="destructive">Destructive</ct-badge>
            <ct-badge variant="outline">Outline</ct-badge>
          </div>
        </section>

        {/* Alert Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>6. Alert Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Alert messages</p>

          <div style="margin-bottom: 1rem;">
            <ct-alert>
              <strong>Default Alert</strong> - This is a default alert message.
            </ct-alert>
          </div>

          <div>
            <ct-alert variant="destructive">
              <strong>Destructive Alert</strong> - This action cannot be undone.
            </ct-alert>
          </div>
        </section>

        {/* Checkbox Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>7. Checkbox Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Checkbox states</p>

          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
            <ct-checkbox id="checkbox1"></ct-checkbox>
            <ct-label for="checkbox1">Unchecked by default</ct-label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
            <ct-checkbox id="checkbox2" checked></ct-checkbox>
            <ct-label for="checkbox2">Checked by default</ct-label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <ct-checkbox id="checkbox3" disabled></ct-checkbox>
            <ct-label for="checkbox3" disabled>Disabled checkbox</ct-label>
          </div>
        </section>

        {/* Switch Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>8. Switch Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Toggle switches</p>

          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
            <ct-switch id="switch1"></ct-switch>
            <ct-label for="switch1">Enable notifications</ct-label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
            <ct-switch id="switch2" checked></ct-switch>
            <ct-label for="switch2">Dark mode (on by default)</ct-label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <ct-switch id="switch3" disabled></ct-switch>
            <ct-label for="switch3" disabled>Disabled switch</ct-label>
          </div>
        </section>

        {/* Slider Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>9. Slider Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Range sliders</p>

          <div style="margin-bottom: 1rem;">
            <ct-label for="slider1">Volume</ct-label>
            <ct-slider
              id="slider1"
              min="0"
              max="100"
              value="50"
            >
            </ct-slider>
          </div>

          <div style="margin-bottom: 1rem;">
            <ct-label for="slider2">Temperature</ct-label>
            <ct-slider
              id="slider2"
              min="0"
              max="30"
              value="22"
              step="0.5"
            >
            </ct-slider>
          </div>
        </section>

        {/* Progress Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>10. Progress Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Progress indicators
          </p>

          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <ct-progress value="0"></ct-progress>
            <ct-progress value="33"></ct-progress>
            <ct-progress value="66"></ct-progress>
            <ct-progress value="100"></ct-progress>
          </div>
        </section>

        {/* Tabs Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>11. Tabs Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Tabbed interface</p>

          <ct-tabs default-value="tab1">
            <ct-tab-list>
              <ct-tab value="tab1">Account</ct-tab>
              <ct-tab value="tab2">Password</ct-tab>
              <ct-tab value="tab3">Settings</ct-tab>
            </ct-tab-list>

            <ct-tab-panel value="tab1">
              <h3>Account Information</h3>
              <p>Manage your account details and preferences here.</p>
            </ct-tab-panel>

            <ct-tab-panel value="tab2">
              <h3>Password Settings</h3>
              <p>Update your password and security settings.</p>
            </ct-tab-panel>

            <ct-tab-panel value="tab3">
              <h3>General Settings</h3>
              <p>Configure your application preferences.</p>
            </ct-tab-panel>
          </ct-tabs>
        </section>

        {/* Accordion Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>12. Accordion Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Collapsible content panels
          </p>

          <ct-accordion>
            <ct-accordion-item value="item-1">
              <div slot="trigger">What is Common UI?</div>
              <div slot="content">
                Common UI is a collection of web components that follow modern
                design principles.
              </div>
            </ct-accordion-item>

            <ct-accordion-item value="item-2">
              <div slot="trigger">How do I use these components?</div>
              <div slot="content">
                Simply import the components and use them as custom HTML
                elements in your markup.
              </div>
            </ct-accordion-item>

            <ct-accordion-item value="item-3">
              <div slot="trigger">Are they framework agnostic?</div>
              <div slot="content">
                Yes! These web components work with any framework or vanilla
                JavaScript.
              </div>
            </ct-accordion-item>
          </ct-accordion>
        </section>

        {/* Separator Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>13. Separator Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">Visual separators</p>

          <div>Content above separator</div>
          <ct-separator></ct-separator>
          <div>Content below separator</div>

          <div style="display: flex; height: 100px; align-items: stretch; margin-top: 1rem;">
            <div>Left content</div>
            <ct-separator orientation="vertical"></ct-separator>
            <div>Right content</div>
          </div>
        </section>

        {/* Toggle Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>14. Toggle & Toggle Group Components</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Toggle buttons and groups
          </p>

          <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
            <ct-toggle>Bold</ct-toggle>
            <ct-toggle pressed>Italic</ct-toggle>
            <ct-toggle>Underline</ct-toggle>
          </div>

          <ct-toggle-group type="single">
            <ct-toggle value="left">Left</ct-toggle>
            <ct-toggle value="center">Center</ct-toggle>
            <ct-toggle value="right">Right</ct-toggle>
          </ct-toggle-group>
        </section>

        {/* Radio Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>15. Radio & Radio Group Components</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Radio buttons with grouping
          </p>

          <ct-radio-group name="options" value="option1">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <ct-radio id="radio1" value="option1"></ct-radio>
              <ct-label for="radio1">Option 1</ct-label>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <ct-radio id="radio2" value="option2"></ct-radio>
              <ct-label for="radio2">Option 2</ct-label>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <ct-radio id="radio3" value="option3"></ct-radio>
              <ct-label for="radio3">Option 3</ct-label>
            </div>
          </ct-radio-group>
        </section>

        {/* Collapsible Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>16. Collapsible Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Expandable content area
          </p>

          <ct-collapsible>
            <ct-button slot="trigger" variant="outline">
              Toggle Content
            </ct-button>
            <div slot="content" style="margin-top: 1rem;">
              <p>This content can be toggled open and closed.</p>
              <p>It's useful for showing/hiding additional information.</p>
            </div>
          </ct-collapsible>
        </section>

        {/* Skeleton Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>17. Skeleton Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Loading placeholders
          </p>

          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <ct-skeleton style="width: 200px; height: 20px;"></ct-skeleton>
            <ct-skeleton style="width: 100px; height: 100px; border-radius: 50%;">
            </ct-skeleton>

            <ct-card>
              <div slot="content">
                <ct-skeleton style="width: 100%; height: 20px; margin-bottom: 8px;">
                </ct-skeleton>
                <ct-skeleton style="width: 80%; height: 20px; margin-bottom: 8px;">
                </ct-skeleton>
                <ct-skeleton style="width: 60%; height: 20px;"></ct-skeleton>
              </div>
            </ct-card>
          </div>
        </section>

        {/* Form Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>18. Form Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Form wrapper with validation
          </p>

          <ct-form>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
              <div>
                <ct-label for="form-name" required>Name</ct-label>
                <ct-input
                  id="form-name"
                  name="name"
                  type="text"
                  placeholder="John Doe"
                  required
                >
                </ct-input>
              </div>

              <div>
                <ct-label for="form-email" required>Email</ct-label>
                <ct-input
                  id="form-email"
                  name="email"
                  type="email"
                  placeholder="john@example.com"
                  required
                >
                </ct-input>
              </div>
            </div>

            <div style="margin-bottom: 1rem;">
              <ct-label for="form-message">Message</ct-label>
              <ct-textarea
                id="form-message"
                name="message"
                placeholder="Your message..."
                rows="4"
              >
              </ct-textarea>
            </div>

            <ct-button type="submit">Submit Form</ct-button>
          </ct-form>
        </section>

        {/* Input OTP Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>19. Input OTP Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            One-time password input
          </p>

          <div>
            <ct-label for="otp-input">Enter verification code</ct-label>
            <ct-input-otp id="otp-input" length="6"></ct-input-otp>
          </div>
        </section>

        {/* Aspect Ratio Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>20. Aspect Ratio Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Maintain aspect ratios
          </p>

          <div style="max-width: 400px; margin-bottom: 1rem;">
            <ct-aspect-ratio ratio="16/9">
              <div style="width: 100%; height: 100%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
                16:9 Aspect Ratio
              </div>
            </ct-aspect-ratio>
          </div>

          <div style="max-width: 400px;">
            <ct-aspect-ratio ratio="1/1">
              <div style="width: 100%; height: 100%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
                1:1 Square
              </div>
            </ct-aspect-ratio>
          </div>
        </section>

        {/* Scroll Area Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>21. Scroll Area Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Custom scrollable area
          </p>

          <ct-scroll-area style="height: 200px; border: 1px solid #e2e8f0; border-radius: 4px;">
            <div style="padding: 1rem;">
              <h3>Scrollable Content</h3>
              <p>This is a custom scroll area component.</p>
              <p>It provides custom styling for scrollbars.</p>
              <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
              <p>
                Sed do eiusmod tempor incididunt ut labore et dolore magna
                aliqua.
              </p>
              <p>Ut enim ad minim veniam, quis nostrud exercitation ullamco.</p>
              <p>Laboris nisi ut aliquip ex ea commodo consequat.</p>
              <p>Duis aute irure dolor in reprehenderit in voluptate velit.</p>
              <p>Esse cillum dolore eu fugiat nulla pariatur.</p>
            </div>
          </ct-scroll-area>
        </section>

        {/* Resizable Panels Component */}
        <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
          <h2>22. Resizable Panels Component</h2>
          <p style="color: #64748b; margin-bottom: 1rem;">
            Resizable panel layout
          </p>

          <div style="height: 400px; border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
            <ct-resizable-panel-group direction="horizontal">
              <ct-resizable-panel default-size="30" min-size="20">
                <div style="padding: 1rem; height: 100%; display: flex; align-items: center; justify-content: center; background: #f1f5f9;">
                  Left Panel (30%)
                </div>
              </ct-resizable-panel>

              <ct-resizable-handle></ct-resizable-handle>

              <ct-resizable-panel default-size="70" min-size="20">
                <div style="padding: 1rem; height: 100%; display: flex; align-items: center; justify-content: center; background: #f1f5f9;">
                  Right Panel (70%)
                </div>
              </ct-resizable-panel>
            </ct-resizable-panel-group>
          </div>
        </section>
      </div>
    ),
  };
});
