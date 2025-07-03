// Nodes just show the shape of the tree
type Node = {
    id: string,
    children: Node[],
}

// Blocks are the backing data for nodes, related by ID
type Block = {
    id: string,
    body: string,
    attachments: Attachment[]
}

// For now, we don't have to worry much about these
type Attachment = {
    [NAME]: string,
    charm: any
}

// This structure allows the same node to appear multiple times in the tree and be edited from anywhere.
// This is in the spirit of Roam Research with its block reference system.
type Tree = {
    root: Node,
    blocks: Block[],
}
