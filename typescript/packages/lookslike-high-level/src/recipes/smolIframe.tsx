import { h } from "@commontools/html";
import { recipe, UI, NAME, derive } from "@commontools/builder";

// @ts-ignore this loads the html file using VITE.js as a string from the html file on disk
import src from "./smolIframe.html?raw";

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
