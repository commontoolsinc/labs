export type Lens<Big, Small> = {
  get: (big: Big) => Small;
  update: (big: Big, small: Small) => Big;
};

export const lens = <Big, Small>({ get, update }: Lens<Big, Small>) =>
  Object.freeze({
    get,
    update,
  });

export default lens;
