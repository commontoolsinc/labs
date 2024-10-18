
declare global {
    namespace JSX {
        interface IntrinsicElements {
            [elemName: string]: any;
        }
    }
}

type VNode = {
    type: 'vnode';
    name: string;
    children: Child[];
    props?: { [key: string]: any };
};

export type Binding = {
    type: "binding";
    name: string;
    path: string[];
};
export type Child = string | number | boolean | null | undefined | VNode | Binding;


const Fragment = 'Fragment';

function h(
    name: string,
    props: { [key: string]: any } | null,
    ...children: (string | VNode)[]
): VNode {
    return {
        type: 'vnode',
        name,
        props: props || {},
        children: children.flat(),
    };
}

export { h, Fragment };
