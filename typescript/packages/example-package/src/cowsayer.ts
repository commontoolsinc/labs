import { cow } from './cowsayer-wasm/example_component.js';

const cowSays = cow.say('moo', undefined);
const owlSays = cow.say('hoo', 'owl');

if (typeof document !== 'undefined') {
  document.documentElement.innerHTML = `
<pre>
<code>
${cowSays}
</code>
</pre>

<pre>
<code>
${owlSays}
</code>
</pre>`;
} else {
  console.log(cowSays);
  console.log(owlSays);
}
