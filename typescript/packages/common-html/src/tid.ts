let _tid = 0;

/** Generate a unique client id for a template */
export const tid = () => `tid${_tid++}`;

export default tid;
