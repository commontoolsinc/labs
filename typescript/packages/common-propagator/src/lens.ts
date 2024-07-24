export type Lens<Big, Small> = {
  get: (big: Big) => Small;
  update: (big: Big, small: Small) => Big;
};
