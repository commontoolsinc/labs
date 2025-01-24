import { h } from "@commontools/common-html";
import { recipe, UI, NAME, derive } from "@commontools/common-builder";

import src from "./smolIframe.html?raw"; // this loads the html file using VITE.js as a string from the html file on disk

const CSP_REPORTER = `
<script>
document.addEventListener('securitypolicyviolation', e => {
  window.parent.postMessage({
    type: 'error',
    data: {
      description: e.violatedDirective,
      source: e.sourceFile,
      lineno: 0,
      colno: 0,
      stacktrace: "",
    }
  }, '*');
});
</script>
`;

const EXT_SCRIPT = `
${CSP_REPORTER}
<script src="https://ajax.googleapis.com/ajax/libs/threejs/r84/three.min.js"></script>
`;

export default recipe<{
    data: { count: number };
}>("smol-iframe", ({ data }) => {

    return {
        [NAME]: 'smol iframe',
        [UI]: <div style="height: 100%">
            <p>outside of iframe, data: {derive(data, data => JSON.stringify(data))}</p>
            <common-iframe
                src={src}
                $context={data}
            ></common-iframe>
        </div>,
        data
    };
});
