let _cid = 0;

/**
 * Create a client-unique ID from an auto-incrementing counter.
 * Cids are only unique within the context of a single page load.
 * Do not persist cids.
 */
export const cid = () => `cid${_cid++}`;
export default cid;
