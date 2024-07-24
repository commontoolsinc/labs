let _cid = 0;

// Generate client ID
export const cid = () => `cid${_cid++}`;

export default cid;
