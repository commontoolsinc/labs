import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/textarea/textarea.js';
import '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/select/select.js';
import '@shoelace-style/shoelace/dist/components/option/option.js';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import type SlTextarea from '@shoelace-style/shoelace/dist/components/textarea/textarea.js';
import type SlInput from '@shoelace-style/shoelace/dist/components/input/input.js';
import type SlCopyButton from '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';
import type SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js';

setBasePath('/shoelace/dist');

const $ = (s) => document.querySelector(s);

const witTextArea = $('sl-textarea[label="WIT"]') as SlTextarea;
const sourceCodeTextArea = $('sl-textarea[label="Source Code"]') as SlTextarea;
const specifierInput = $('sl-input') as SlInput;
const copyButton = $('sl-copy-button') as SlCopyButton;
const languageSelect = $('sl-select[label="Language"]') as SlSelect;

witTextArea.value = `package example:hello;
world hello {
  export hello: func() -> string;
}`;

sourceCodeTextArea.value = `export function hello() {
  return 'Hello, ShmavaScript!'
}`;

for (const textArea of [witTextArea, sourceCodeTextArea]) {
  textArea.addEventListener('input', () => updateSpecifier());
}

const updateSpecifier = () => {
  const witBase64 = btoa(witTextArea.value);
  const sourceCodeBase64 = btoa(sourceCodeTextArea.value);
  const language = languageSelect.value;

  const specifier = `${window.location.origin}/module/on-demand/${language}/${witBase64}/${sourceCodeBase64}`;

  specifierInput.value = specifier;
  copyButton.value = specifier;
};

updateSpecifier();
