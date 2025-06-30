# Component Reference Guide

## Table of Contents

1. [UI Components v2 (@commontools/ui)](#ui-components-v2-commontoolsui)
2. [Jumble React Components](#jumble-react-components)
3. [Component Patterns](#component-patterns)
4. [Styling and Theming](#styling-and-theming)
5. [Event Handling](#event-handling)

## UI Components v2 (@commontools/ui)

### Layout Components

#### CTVStack
Vertical stack layout component.

```typescript
import { CTVStack } from "@commontools/ui/v2/components/ct-vstack";

// Properties
interface CTVStackProps {
  gap?: string;        // CSS gap value (e.g., "4", "1rem", "8px")
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between" | "space-around";
}

// Usage
<ct-vstack gap="4" align="center">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</ct-vstack>
```

#### CTHStack
Horizontal stack layout component.

```typescript
import { CTHStack } from "@commontools/ui/v2/components/ct-hstack";

// Properties (same as CTVStack)
<ct-hstack gap="2" justify="space-between">
  <button>Cancel</button>
  <button>Save</button>
</ct-hstack>
```

#### CTGrid
CSS Grid layout component.

```typescript
import { CTGrid } from "@commontools/ui/v2/components/ct-grid";

// Properties
interface CTGridProps {
  columns?: string;    // CSS grid-template-columns value
  rows?: string;       // CSS grid-template-rows value
  gap?: string;        // CSS gap value
  areas?: string;      // CSS grid-template-areas value
}

// Usage
<ct-grid columns="repeat(3, 1fr)" gap="4">
  <div>Cell 1</div>
  <div>Cell 2</div>
  <div>Cell 3</div>
</ct-grid>

// With named areas
<ct-grid 
  columns="200px 1fr 200px" 
  areas="'header header header' 'sidebar main aside' 'footer footer footer'"
>
  <div style="grid-area: header">Header</div>
  <div style="grid-area: sidebar">Sidebar</div>
  <div style="grid-area: main">Main</div>
  <div style="grid-area: aside">Aside</div>
  <div style="grid-area: footer">Footer</div>
</ct-grid>
```

#### CTCard
Card container component.

```typescript
import { CTCard } from "@commontools/ui/v2/components/ct-card";

// Properties
interface CTCardProps {
  variant?: "default" | "outline" | "ghost";
  padding?: string;
  elevation?: "none" | "sm" | "md" | "lg";
}

// Usage
<ct-card variant="outline" padding="6">
  <h3>Card Title</h3>
  <p>Card content goes here.</p>
  <ct-button>Action</ct-button>
</ct-card>
```

### Form Components

#### CTButton
Button component with multiple variants.

```typescript
import { CTButton } from "@commontools/ui/v2/components/ct-button";

// Types
type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";

// Properties
interface CTButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
}

// Usage
<ct-button variant="default" size="lg">Primary Action</ct-button>
<ct-button variant="outline" size="sm">Secondary</ct-button>
<ct-button variant="destructive" disabled>Delete</ct-button>
<ct-button variant="ghost" size="icon">
  <svg>...</svg>
</ct-button>

// With loading state
<ct-button loading>
  Saving...
</ct-button>
```

#### CTInput
Text input component.

```typescript
import { CTInput } from "@commontools/ui/v2/components/ct-input";

// Types
type InputType = "text" | "email" | "password" | "number" | "tel" | "url" | "search";

// Properties
interface CTInputProps {
  type?: InputType;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  pattern?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  size?: "sm" | "default" | "lg";
}

// Usage
<ct-input 
  type="email" 
  placeholder="Enter your email"
  required
  size="lg"
/>

<ct-input 
  type="number" 
  min="0" 
  max="100" 
  step="1"
  value="50"
/>

// With validation
<ct-input 
  type="password"
  pattern="^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$"
  placeholder="Strong password required"
/>
```

#### CTTextarea
Multi-line text input component.

```typescript
import { CTTextarea } from "@commontools/ui/v2/components/ct-textarea";

// Properties
interface CTTextareaProps {
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  rows?: number;
  cols?: number;
  resize?: "none" | "both" | "horizontal" | "vertical";
}

// Usage
<ct-textarea 
  placeholder="Enter your message"
  rows="4"
  resize="vertical"
/>

<ct-textarea 
  value="Pre-filled content"
  readonly
  rows="10"
/>
```

#### CTSelect
Dropdown select component.

```typescript
import { CTSelect } from "@commontools/ui/v2/components/ct-select";

// Properties
interface CTSelectProps {
  value?: string;
  disabled?: boolean;
  required?: boolean;
  multiple?: boolean;
  size?: "sm" | "default" | "lg";
  placeholder?: string;
}

// Usage
<ct-select value="option2" placeholder="Choose an option">
  <option value="option1">Option 1</option>
  <option value="option2">Option 2</option>
  <option value="option3">Option 3</option>
</ct-select>

// Multiple selection
<ct-select multiple>
  <optgroup label="Group 1">
    <option value="a">Option A</option>
    <option value="b">Option B</option>
  </optgroup>
  <optgroup label="Group 2">
    <option value="c">Option C</option>
    <option value="d">Option D</option>
  </optgroup>
</ct-select>
```

#### CTCheckbox
Checkbox input component.

```typescript
import { CTCheckbox } from "@commontools/ui/v2/components/ct-checkbox";

// Properties
interface CTCheckboxProps {
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  indeterminate?: boolean;
  value?: string;
  name?: string;
}

// Usage
<ct-checkbox checked>I agree to the terms</ct-checkbox>
<ct-checkbox disabled>Disabled option</ct-checkbox>
<ct-checkbox indeterminate>Partial selection</ct-checkbox>

// In a form
<ct-form>
  <ct-checkbox name="newsletter" value="yes">
    Subscribe to newsletter
  </ct-checkbox>
  <ct-checkbox name="updates" value="yes" checked>
    Receive product updates
  </ct-checkbox>
</ct-form>
```

#### CTRadioGroup & CTRadio
Radio button group components.

```typescript
import { CTRadioGroup, CTRadio } from "@commontools/ui/v2/components/ct-radio-group";

// Properties
interface CTRadioGroupProps {
  value?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  orientation?: "horizontal" | "vertical";
}

interface CTRadioProps {
  value: string;
  disabled?: boolean;
  checked?: boolean;
}

// Usage
<ct-radio-group value="option2" name="choice" orientation="vertical">
  <ct-radio value="option1">First option</ct-radio>
  <ct-radio value="option2">Second option</ct-radio>
  <ct-radio value="option3" disabled>Third option (disabled)</ct-radio>
</ct-radio-group>
```

### Navigation Components

#### CTTabs, CTTabList, CTTab, CTTabPanel
Tab navigation components.

```typescript
import { 
  CTTabs, 
  CTTabList, 
  CTTab, 
  CTTabPanel 
} from "@commontools/ui/v2/components";

// Properties
interface CTTabsProps {
  value?: string;
  orientation?: "horizontal" | "vertical";
  activationMode?: "automatic" | "manual";
}

// Usage
<ct-tabs value="tab1" orientation="horizontal">
  <ct-tab-list>
    <ct-tab value="tab1">Overview</ct-tab>
    <ct-tab value="tab2">Details</ct-tab>
    <ct-tab value="tab3">Settings</ct-tab>
  </ct-tab-list>
  
  <ct-tab-panel value="tab1">
    <h3>Overview Content</h3>
    <p>This is the overview tab content.</p>
  </ct-tab-panel>
  
  <ct-tab-panel value="tab2">
    <h3>Details Content</h3>
    <p>This is the details tab content.</p>
  </ct-tab-panel>
  
  <ct-tab-panel value="tab3">
    <h3>Settings Content</h3>
    <p>This is the settings tab content.</p>
  </ct-tab-panel>
</ct-tabs>

// Vertical tabs
<ct-tabs value="tab1" orientation="vertical">
  <!-- Same structure as above -->
</ct-tabs>
```

#### CTAccordion & CTAccordionItem
Collapsible content components.

```typescript
import { CTAccordion, CTAccordionItem } from "@commontools/ui/v2/components";

// Types
type AccordionType = "single" | "multiple";

// Properties
interface CTAccordionProps {
  type?: AccordionType;
  value?: string | string[];
  collapsible?: boolean;
}

// Usage - Single selection
<ct-accordion type="single" value="item1">
  <ct-accordion-item value="item1">
    <h3 slot="trigger">Section 1</h3>
    <p>Content for the first section.</p>
  </ct-accordion-item>
  
  <ct-accordion-item value="item2">
    <h3 slot="trigger">Section 2</h3>
    <p>Content for the second section.</p>
  </ct-accordion-item>
  
  <ct-accordion-item value="item3">
    <h3 slot="trigger">Section 3</h3>
    <p>Content for the third section.</p>
  </ct-accordion-item>
</ct-accordion>

// Multiple selection
<ct-accordion type="multiple">
  <ct-accordion-item value="faq1">
    <h4 slot="trigger">How do I get started?</h4>
    <p>To get started, follow these steps...</p>
  </ct-accordion-item>
  
  <ct-accordion-item value="faq2">
    <h4 slot="trigger">What are the pricing options?</h4>
    <p>We offer several pricing tiers...</p>
  </ct-accordion-item>
</ct-accordion>
```

### Feedback Components

#### CTAlert
Alert/notification component.

```typescript
import { CTAlert } from "@commontools/ui/v2/components/ct-alert";

// Types
type AlertVariant = "default" | "destructive" | "warning" | "success" | "info";

// Properties
interface CTAlertProps {
  variant?: AlertVariant;
  dismissible?: boolean;
}

// Usage
<ct-alert variant="success">
  <strong>Success!</strong> Your changes have been saved.
</ct-alert>

<ct-alert variant="destructive" dismissible>
  <strong>Error!</strong> Something went wrong. Please try again.
</ct-alert>

<ct-alert variant="warning">
  <strong>Warning!</strong> This action cannot be undone.
</ct-alert>

// With custom icon
<ct-alert variant="info">
  <svg slot="icon" width="16" height="16">...</svg>
  <strong>Info:</strong> New features are available.
</ct-alert>
```

#### CTBadge
Small status/label component.

```typescript
import { CTBadge } from "@commontools/ui/v2/components/ct-badge";

// Types
type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Properties
interface CTBadgeProps {
  variant?: BadgeVariant;
  size?: "sm" | "default" | "lg";
}

// Usage
<ct-badge variant="default">New</ct-badge>
<ct-badge variant="secondary">Beta</ct-badge>
<ct-badge variant="destructive">Error</ct-badge>
<ct-badge variant="outline">Draft</ct-badge>

// In context
<h3>
  Article Title 
  <ct-badge variant="secondary" size="sm">Published</ct-badge>
</h3>
```

#### CTProgress
Progress indicator component.

```typescript
import { CTProgress } from "@commontools/ui/v2/components/ct-progress";

// Properties
interface CTProgressProps {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "success" | "warning" | "error";
}

// Usage
<ct-progress value="65" max="100"></ct-progress>

// Indeterminate progress
<ct-progress indeterminate></ct-progress>

// Different variants
<ct-progress value="100" variant="success"></ct-progress>
<ct-progress value="75" variant="warning"></ct-progress>
<ct-progress value="25" variant="error"></ct-progress>

// With label
<div>
  <label>Upload Progress</label>
  <ct-progress value="45" max="100"></ct-progress>
  <span>45% complete</span>
</div>
```

#### CTSkeleton
Loading placeholder component.

```typescript
import { CTSkeleton } from "@commontools/ui/v2/components/ct-skeleton";

// Types
type SkeletonVariant = "default" | "text" | "circular";

// Properties
interface CTSkeletonProps {
  variant?: SkeletonVariant;
  width?: string;
  height?: string;
  animation?: "pulse" | "wave" | "none";
}

// Usage
<ct-skeleton variant="text" width="200px" height="20px"></ct-skeleton>
<ct-skeleton variant="circular" width="40px" height="40px"></ct-skeleton>
<ct-skeleton variant="default" width="100%" height="200px"></ct-skeleton>

// Loading card skeleton
<ct-card>
  <ct-vstack gap="3">
    <ct-hstack gap="3" align="center">
      <ct-skeleton variant="circular" width="40px" height="40px"></ct-skeleton>
      <ct-vstack gap="1">
        <ct-skeleton variant="text" width="120px" height="16px"></ct-skeleton>
        <ct-skeleton variant="text" width="80px" height="14px"></ct-skeleton>
      </ct-vstack>
    </ct-hstack>
    <ct-skeleton variant="default" width="100%" height="120px"></ct-skeleton>
    <ct-skeleton variant="text" width="60%" height="16px"></ct-skeleton>
  </ct-vstack>
</ct-card>
```

### Utility Components

#### CTSeparator
Visual separator component.

```typescript
import { CTSeparator } from "@commontools/ui/v2/components/ct-separator";

// Types
type SeparatorOrientation = "horizontal" | "vertical";

// Properties
interface CTSeparatorProps {
  orientation?: SeparatorOrientation;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "dashed" | "dotted";
}

// Usage
<ct-separator orientation="horizontal"></ct-separator>

<ct-hstack gap="4">
  <div>Left content</div>
  <ct-separator orientation="vertical"></ct-separator>
  <div>Right content</div>
</ct-hstack>

// Different styles
<ct-separator variant="dashed"></ct-separator>
<ct-separator variant="dotted" size="lg"></ct-separator>
```

#### CTScrollArea
Custom scrollable area component.

```typescript
import { CTScrollArea } from "@commontools/ui/v2/components/ct-scroll-area";

// Types
type ScrollOrientation = "vertical" | "horizontal" | "both";

// Properties
interface CTScrollAreaProps {
  orientation?: ScrollOrientation;
  maxHeight?: string;
  maxWidth?: string;
  scrollbarWidth?: "thin" | "default" | "thick";
}

// Usage
<ct-scroll-area orientation="vertical" maxHeight="300px">
  <div style="height: 600px;">
    <p>Long content that will scroll...</p>
    <!-- More content -->
  </div>
</ct-scroll-area>

// Horizontal scrolling
<ct-scroll-area orientation="horizontal" maxWidth="400px">
  <div style="width: 800px; white-space: nowrap;">
    Wide content that scrolls horizontally
  </div>
</ct-scroll-area>
```

## Jumble React Components

### Core Application Components

#### Composer
Main recipe editing interface.

```typescript
import { Composer } from "@commontools/jumble/components/Composer";

interface ComposerProps {
  recipe?: Recipe;
  onChange?: (recipe: Recipe) => void;
  onSave?: (recipe: Recipe) => void;
  readOnly?: boolean;
  showPreview?: boolean;
}

// Usage
<Composer 
  recipe={currentRecipe}
  onChange={handleRecipeChange}
  onSave={handleSave}
  showPreview={true}
/>
```

#### CharmRunner
Execute and display charm results.

```typescript
import { CharmRunner } from "@commontools/jumble/components/CharmRunner";

interface CharmRunnerProps {
  charm: Cell<Charm>;
  onResult?: (result: any) => void;
  onError?: (error: Error) => void;
  autoRun?: boolean;
}

// Usage
<CharmRunner 
  charm={charmCell}
  onResult={handleResult}
  onError={handleError}
  autoRun={true}
/>
```

#### NetworkInspector
Debug network requests and responses.

```typescript
import { NetworkInspector } from "@commontools/jumble/components/NetworkInspector";

interface NetworkInspectorProps {
  requests: NetworkRequest[];
  onRequestSelect?: (request: NetworkRequest) => void;
  showDetails?: boolean;
}

// Usage
<NetworkInspector 
  requests={networkRequests}
  onRequestSelect={handleRequestSelect}
  showDetails={true}
/>
```

### Specialized Components

#### CharmCodeEditor
Code editing with syntax highlighting.

```typescript
import { CharmCodeEditor } from "@commontools/jumble/components/CharmCodeEditor";

interface CharmCodeEditorProps {
  code: string;
  language?: "typescript" | "javascript" | "json" | "markdown";
  onChange?: (code: string) => void;
  readOnly?: boolean;
  theme?: "light" | "dark";
  showLineNumbers?: boolean;
}

// Usage
<CharmCodeEditor 
  code={sourceCode}
  language="typescript"
  onChange={handleCodeChange}
  showLineNumbers={true}
  theme="dark"
/>
```

#### AudioRecorderInput
Voice input component.

```typescript
import { AudioRecorderInput } from "@commontools/jumble/components/AudioRecorderInput";

interface AudioRecorderInputProps {
  onRecording?: (audioData: Blob) => void;
  onTranscription?: (text: string) => void;
  maxDuration?: number;
  autoTranscribe?: boolean;
}

// Usage
<AudioRecorderInput 
  onRecording={handleAudioData}
  onTranscription={handleTranscription}
  maxDuration={60}
  autoTranscribe={true}
/>
```

#### FeedbackDialog
User feedback collection.

```typescript
import { FeedbackDialog } from "@commontools/jumble/components/FeedbackDialog";

interface FeedbackDialogProps {
  open: boolean;
  onSubmit?: (feedback: FeedbackData) => void;
  onClose?: () => void;
  title?: string;
  context?: any;
}

// Usage
<FeedbackDialog 
  open={showFeedback}
  onSubmit={handleFeedback}
  onClose={() => setShowFeedback(false)}
  title="How was this response?"
  context={currentResponse}
/>
```

## Component Patterns

### Custom Elements Pattern

All UI components follow the custom elements pattern:

```typescript
import { BaseElement } from "@commontools/ui/v2/core/base-element";
import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("my-component")
export class MyComponent extends BaseElement {
  @property() value = "";
  @property({ type: Boolean }) disabled = false;
  
  static styles = css`
    :host {
      display: block;
    }
    
    :host([disabled]) {
      opacity: 0.5;
      pointer-events: none;
    }
  `;
  
  render() {
    return html`
      <div class="component-content">
        <slot></slot>
      </div>
    `;
  }
  
  private handleEvent() {
    this.dispatchEvent(new CustomEvent("my-event", {
      detail: { value: this.value },
      bubbles: true
    }));
  }
}
```

### Composition Pattern

Components are designed to be composable:

```typescript
// Form composition
<ct-form>
  <ct-vstack gap="4">
    <ct-input placeholder="Name" required></ct-input>
    <ct-textarea placeholder="Description"></ct-textarea>
    <ct-hstack gap="2" justify="end">
      <ct-button variant="outline">Cancel</ct-button>
      <ct-button type="submit">Save</ct-button>
    </ct-hstack>
  </ct-vstack>
</ct-form>

// Card with content
<ct-card>
  <ct-vstack gap="3">
    <ct-hstack gap="2" align="center">
      <h3>Title</h3>
      <ct-badge variant="secondary">New</ct-badge>
    </ct-hstack>
    <ct-separator></ct-separator>
    <p>Content goes here</p>
    <ct-button variant="outline" size="sm">Learn More</ct-button>
  </ct-vstack>
</ct-card>
```

## Styling and Theming

### CSS Custom Properties

Components use CSS custom properties for theming:

```css
:root {
  /* Colors */
  --ct-color-primary: #3b82f6;
  --ct-color-secondary: #6b7280;
  --ct-color-success: #10b981;
  --ct-color-warning: #f59e0b;
  --ct-color-error: #ef4444;
  
  /* Spacing */
  --ct-spacing-1: 0.25rem;
  --ct-spacing-2: 0.5rem;
  --ct-spacing-3: 0.75rem;
  --ct-spacing-4: 1rem;
  
  /* Typography */
  --ct-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto;
  --ct-font-size-sm: 0.875rem;
  --ct-font-size-base: 1rem;
  --ct-font-size-lg: 1.125rem;
  
  /* Borders */
  --ct-border-radius: 0.375rem;
  --ct-border-width: 1px;
  --ct-border-color: #e5e7eb;
}

/* Dark theme */
[data-theme="dark"] {
  --ct-color-primary: #60a5fa;
  --ct-border-color: #374151;
  /* ... other dark theme values */
}
```

### Component-Specific Styling

```css
/* Customize specific components */
ct-button {
  --ct-button-padding: 0.5rem 1rem;
  --ct-button-border-radius: 0.25rem;
}

ct-card {
  --ct-card-padding: 1.5rem;
  --ct-card-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

## Event Handling

### Standard Events

Components emit standard DOM events:

```typescript
// Input events
document.querySelector('ct-input').addEventListener('input', (e) => {
  console.log('Input value:', e.target.value);
});

// Change events
document.querySelector('ct-select').addEventListener('change', (e) => {
  console.log('Selected value:', e.target.value);
});

// Click events
document.querySelector('ct-button').addEventListener('click', (e) => {
  console.log('Button clicked');
});
```

### Custom Events

Components also emit custom events with additional data:

```typescript
// Tab change event
document.querySelector('ct-tabs').addEventListener('tab-change', (e) => {
  console.log('Active tab:', e.detail.value);
  console.log('Previous tab:', e.detail.previousValue);
});

// Accordion toggle event
document.querySelector('ct-accordion').addEventListener('item-toggle', (e) => {
  console.log('Item:', e.detail.value);
  console.log('Expanded:', e.detail.expanded);
});

// Form submission event
document.querySelector('ct-form').addEventListener('form-submit', (e) => {
  console.log('Form data:', e.detail.formData);
  console.log('Validation:', e.detail.valid);
});
```

### Event Delegation

For dynamic content, use event delegation:

```typescript
// Handle all button clicks in a container
document.querySelector('.container').addEventListener('click', (e) => {
  if (e.target.matches('ct-button')) {
    console.log('Button clicked:', e.target);
  }
});
```

---

This component reference provides detailed information about all available UI components, their properties, usage patterns, and styling options. For the most up-to-date information, refer to the component source code and examples in the codebase.