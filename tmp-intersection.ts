const ID: unique symbol = Symbol();
const ID_FIELD: unique symbol = Symbol();

type IDFields = {
  [ID]?: unknown;
  [ID_FIELD]?: unknown;
};

type IDUser = IDFields['user'];

const _shouldBeNever: IDUser extends never ? true : false = true;
