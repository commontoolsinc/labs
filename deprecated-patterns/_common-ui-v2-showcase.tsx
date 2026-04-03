/// <cts-enable />
import { NAME, pattern, schema, str, UI } from "commonfabric";

const model = schema({
  type: "object",
  properties: {},
  default: {},
});

export default pattern(
  () => {
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
              <cf-button>Default</cf-button>
              <cf-button variant="secondary">Secondary</cf-button>
              <cf-button variant="destructive">Destructive</cf-button>
              <cf-button variant="outline">Outline</cf-button>
              <cf-button variant="ghost">Ghost</cf-button>
              <cf-button variant="link">Link</cf-button>
            </div>

            <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
              <cf-button size="sm">Small</cf-button>
              <cf-button>Default Size</cf-button>
              <cf-button size="lg">Large</cf-button>
              <cf-button size="icon">🎯</cf-button>
              <cf-button disabled>Disabled</cf-button>
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
                <cf-label for="text-input">Text Input</cf-label>
                <cf-input
                  id="text-input"
                  type="text"
                  placeholder="Enter text..."
                >
                </cf-input>
              </div>

              <div>
                <cf-label for="email-input" required>Email Input</cf-label>
                <cf-input
                  id="email-input"
                  type="email"
                  placeholder="you@example.com"
                >
                </cf-input>
              </div>

              <div>
                <cf-label for="password-input">Password Input</cf-label>
                <cf-input
                  id="password-input"
                  type="password"
                  placeholder="Enter password..."
                >
                </cf-input>
              </div>

              <div>
                <cf-label for="number-input">Number Input</cf-label>
                <cf-input
                  id="number-input"
                  type="number"
                  placeholder="0"
                  min="0"
                  max="100"
                >
                </cf-input>
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
                <cf-label for="basic-textarea">Basic Textarea</cf-label>
                <cf-textarea
                  id="basic-textarea"
                  placeholder="Enter your message..."
                  rows={4}
                >
                </cf-textarea>
              </div>

              <div>
                <cf-label for="auto-textarea">Auto-resize Textarea</cf-label>
                <cf-textarea
                  id="auto-textarea"
                  placeholder="This grows as you type..."
                  auto-resize
                  rows={2}
                >
                </cf-textarea>
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
              <cf-card>
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
                  <cf-button size="sm">Action</cf-button>
                </div>
              </cf-card>

              <cf-card>
                <div slot="content">
                  <h3>Simple Card</h3>
                  <p>Cards don't require all slots to be filled.</p>
                </div>
              </cf-card>
            </div>
          </section>

          {/* Badge Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>5. Badge Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Badge variations</p>

            <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
              <cf-badge>Default</cf-badge>
              <cf-badge variant="secondary">Secondary</cf-badge>
              <cf-badge variant="destructive">Destructive</cf-badge>
              <cf-badge variant="outline">Outline</cf-badge>
            </div>
          </section>

          {/* Alert Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>6. Alert Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Alert messages</p>

            <div style="margin-bottom: 1rem;">
              <cf-alert>
                <strong>Default Alert</strong>{" "}
                - This is a default alert message.
              </cf-alert>
            </div>

            <div>
              <cf-alert variant="destructive">
                <strong>Destructive Alert</strong>{" "}
                - This action cannot be undone.
              </cf-alert>
            </div>
          </section>

          {/* Checkbox Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>7. Checkbox Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Checkbox states</p>

            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
              <cf-checkbox id="checkbox1"></cf-checkbox>
              <cf-label for="checkbox1">Unchecked by default</cf-label>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
              <cf-checkbox id="checkbox2" checked></cf-checkbox>
              <cf-label for="checkbox2">Checked by default</cf-label>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <cf-checkbox id="checkbox3" disabled></cf-checkbox>
              <cf-label for="checkbox3" disabled>Disabled checkbox</cf-label>
            </div>
          </section>

          {/* Switch Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>8. Switch Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Toggle switches</p>

            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
              <cf-switch id="switch1"></cf-switch>
              <cf-label for="switch1">Enable notifications</cf-label>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
              <cf-switch id="switch2" checked></cf-switch>
              <cf-label for="switch2">Dark mode (on by default)</cf-label>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <cf-switch id="switch3" disabled></cf-switch>
              <cf-label for="switch3" disabled>Disabled switch</cf-label>
            </div>
          </section>

          {/* Slider Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>9. Slider Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Range sliders</p>

            <div style="margin-bottom: 1rem;">
              <cf-label for="slider1">Volume</cf-label>
              <cf-slider
                id="slider1"
                min={0}
                max={100}
                value={50}
              >
              </cf-slider>
            </div>

            <div style="margin-bottom: 1rem;">
              <cf-label for="slider2">Temperature</cf-label>
              <cf-slider
                id="slider2"
                min={0}
                max={30}
                value={22}
                step={0.5}
              >
              </cf-slider>
            </div>
          </section>

          {/* Progress Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>10. Progress Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Progress indicators
            </p>

            <div style="display: flex; flex-direction: column; gap: 1rem;">
              <cf-progress value={0}></cf-progress>
              <cf-progress value={33}></cf-progress>
              <cf-progress value={66}></cf-progress>
              <cf-progress value={100}></cf-progress>
            </div>
          </section>

          {/* Tabs Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>11. Tabs Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">Tabbed interface</p>

            <cf-tabs default-value="tab1">
              <cf-tab-list>
                <cf-tab value="tab1">Account</cf-tab>
                <cf-tab value="tab2">Password</cf-tab>
                <cf-tab value="tab3">Settings</cf-tab>
              </cf-tab-list>

              <cf-tab-panel value="tab1">
                <h3>Account Information</h3>
                <p>Manage your account details and preferences here.</p>
              </cf-tab-panel>

              <cf-tab-panel value="tab2">
                <h3>Password Settings</h3>
                <p>Update your password and security settings.</p>
              </cf-tab-panel>

              <cf-tab-panel value="tab3">
                <h3>General Settings</h3>
                <p>Configure your application preferences.</p>
              </cf-tab-panel>
            </cf-tabs>
          </section>

          {/* Accordion Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>12. Accordion Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Collapsible content panels
            </p>

            <cf-accordion>
              <cf-accordion-item value="item-1">
                <div slot="trigger">What is Common UI?</div>
                <div slot="content">
                  Common UI is a collection of web components that follow modern
                  design principles.
                </div>
              </cf-accordion-item>

              <cf-accordion-item value="item-2">
                <div slot="trigger">How do I use these components?</div>
                <div slot="content">
                  Simply import the components and use them as custom HTML
                  elements in your markup.
                </div>
              </cf-accordion-item>

              <cf-accordion-item value="item-3">
                <div slot="trigger">Are they framework agnostic?</div>
                <div slot="content">
                  Yes! These web components work with any framework or vanilla
                  JavaScript.
                </div>
              </cf-accordion-item>
            </cf-accordion>
          </section>

          {/* Separator Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>13. Separator Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Visual separators
            </p>

            <div>Content above separator</div>
            <cf-separator></cf-separator>
            <div>Content below separator</div>

            <div style="display: flex; height: 100px; align-items: stretch; margin-top: 1rem;">
              <div>Left content</div>
              <cf-separator orientation="vertical"></cf-separator>
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
              <cf-toggle>Bold</cf-toggle>
              <cf-toggle pressed>Italic</cf-toggle>
              <cf-toggle>Underline</cf-toggle>
            </div>

            <cf-toggle-group type="single">
              <cf-toggle>Left</cf-toggle>
              <cf-toggle>Center</cf-toggle>
              <cf-toggle>Right</cf-toggle>
            </cf-toggle-group>
          </section>

          {/* Radio Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>15. Radio & Radio Group Components</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Radio buttons with grouping
            </p>

            <cf-radio-group name="options" value="option1">
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <cf-radio id="radio1" value="option1"></cf-radio>
                <cf-label for="radio1">Option 1</cf-label>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <cf-radio id="radio2" value="option2"></cf-radio>
                <cf-label for="radio2">Option 2</cf-label>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <cf-radio id="radio3" value="option3"></cf-radio>
                <cf-label for="radio3">Option 3</cf-label>
              </div>
            </cf-radio-group>
          </section>

          {/* Collapsible Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>16. Collapsible Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Expandable content area
            </p>

            <cf-collapsible>
              <cf-button slot="trigger" variant="outline">
                Toggle Content
              </cf-button>
              <div slot="content" style="margin-top: 1rem;">
                <p>This content can be toggled open and closed.</p>
                <p>It's useful for showing/hiding additional information.</p>
              </div>
            </cf-collapsible>
          </section>

          {/* Skeleton Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>17. Skeleton Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Loading placeholders
            </p>

            <div style="display: flex; flex-direction: column; gap: 1rem;">
              <cf-skeleton style="width: 200px; height: 20px;"></cf-skeleton>
              <cf-skeleton style="width: 100px; height: 100px; border-radius: 50%;">
              </cf-skeleton>

              <cf-card>
                <div slot="content">
                  <cf-skeleton style="width: 100%; height: 20px; margin-bottom: 8px;">
                  </cf-skeleton>
                  <cf-skeleton style="width: 80%; height: 20px; margin-bottom: 8px;">
                  </cf-skeleton>
                  <cf-skeleton style="width: 60%; height: 20px;"></cf-skeleton>
                </div>
              </cf-card>
            </div>
          </section>

          {/* Form Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>18. Form Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Form wrapper with validation
            </p>

            <cf-form>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
                <div>
                  <cf-label for="form-name" required>Name</cf-label>
                  <cf-input
                    id="form-name"
                    name="name"
                    type="text"
                    placeholder="John Doe"
                    required
                  >
                  </cf-input>
                </div>

                <div>
                  <cf-label for="form-email" required>Email</cf-label>
                  <cf-input
                    id="form-email"
                    name="email"
                    type="email"
                    placeholder="john@example.com"
                    required
                  >
                  </cf-input>
                </div>
              </div>

              <div style="margin-bottom: 1rem;">
                <cf-label for="form-message">Message</cf-label>
                <cf-textarea
                  id="form-message"
                  name="message"
                  placeholder="Your message..."
                  rows={4}
                >
                </cf-textarea>
              </div>

              <cf-button type="submit">Submit Form</cf-button>
            </cf-form>
          </section>

          {/* Input OTP Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>19. Input OTP Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              One-time password input
            </p>

            <div>
              <cf-label for="otp-input">Enter verification code</cf-label>
              <cf-input-otp id="otp-input" length={6}></cf-input-otp>
            </div>
          </section>

          {/* Aspect Ratio Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>20. Aspect Ratio Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Maintain aspect ratios
            </p>

            <div style="max-width: 400px; margin-bottom: 1rem;">
              <cf-aspect-ratio ratio="16/9">
                <div style="width: 100%; height: 100%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
                  16:9 Aspect Ratio
                </div>
              </cf-aspect-ratio>
            </div>

            <div style="max-width: 400px;">
              <cf-aspect-ratio ratio="1/1">
                <div style="width: 100%; height: 100%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
                  1:1 Square
                </div>
              </cf-aspect-ratio>
            </div>
          </section>

          {/* Scroll Area Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>21. Scroll Area Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Custom scrollable area
            </p>

            <cf-scroll-area style="height: 200px; border: 1px solid #e2e8f0; border-radius: 4px;">
              <div style="padding: 1rem;">
                <h3>Scrollable Content</h3>
                <p>This is a custom scroll area component.</p>
                <p>It provides custom styling for scrollbars.</p>
                <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
                <p>
                  Sed do eiusmod tempor incididunt ut labore et dolore magna
                  aliqua.
                </p>
                <p>
                  Ut enim ad minim veniam, quis nostrud exercitation ullamco.
                </p>
                <p>Laboris nisi ut aliquip ex ea commodo consequat.</p>
                <p>
                  Duis aute irure dolor in reprehenderit in voluptate velit.
                </p>
                <p>Esse cillum dolore eu fugiat nulla pariatur.</p>
              </div>
            </cf-scroll-area>
          </section>

          {/* Resizable Panels Component */}
          <section style="margin-bottom: 3rem; padding: 2rem; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <h2>22. Resizable Panels Component</h2>
            <p style="color: #64748b; margin-bottom: 1rem;">
              Resizable panel layout
            </p>

            <div style="height: 400px; border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
              <cf-resizable-panel-group direction="horizontal">
                <cf-resizable-panel default-size="30" min-size="20">
                  <div style="padding: 1rem; height: 100%; display: flex; align-items: center; justify-content: center; background: #f1f5f9;">
                    Left Panel (30%)
                  </div>
                </cf-resizable-panel>

                <cf-resizable-handle></cf-resizable-handle>

                <cf-resizable-panel default-size="70" min-size="20">
                  <div style="padding: 1rem; height: 100%; display: flex; align-items: center; justify-content: center; background: #f1f5f9;">
                    Right Panel (70%)
                  </div>
                </cf-resizable-panel>
              </cf-resizable-panel-group>
            </div>
          </section>
        </div>
      ),
    };
  },
  model,
  model,
);
