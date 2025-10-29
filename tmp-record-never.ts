type Additional = Record<never, never>;

type AdditionalUser = Additional['user'];

const _assert: AdditionalUser extends never ? true : false = true;
