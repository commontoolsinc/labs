import { VNode, Child } from "./view.js";

declare global {
    namespace JSX {
        interface IntrinsicElements {
            [elemName: string]: any;
        }
    }
}

const Fragment = 'Fragment';

function h(
    name: string,
    props: { [key: string]: any } | null,
    ...children: Child[]
): VNode {
    return {
        type: 'vnode',
        name,
        props: props || {},
        children: children.flat(),
    };
}

export { h, Fragment };
