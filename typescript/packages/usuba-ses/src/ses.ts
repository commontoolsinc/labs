import 'ses';

// NOTE: Gotta do this indirection because of the way Compartment is not
// declared as a member of globalThis
export const CompartmentAlias = Compartment;
