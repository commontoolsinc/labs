export type Cid = string;

let _cid = 0;

// Generate client ID
export const cid = (): Cid => `cid${_cid++}`;

export default cid;
