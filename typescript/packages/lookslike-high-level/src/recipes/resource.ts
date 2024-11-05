import {
  cell,
  fetchData,
  handler,
  lift,
  recipe,
} from "@commontools/common-builder";

export type Request = Parameters<typeof fetchData>[0];

// see: https://docs.solidjs.com/reference/basic-reactivity/create-resource
export const resource = recipe<
  { request: Request },
  { result: any; pending: boolean; error: any; refetch: () => {} }
>("Resource", ({ request }) => {
  const id = cell(0);
  const payload = lift(
    ({ id, request }: { id: number; request: Request }) => request,
  );
  const refetch = handler((_: unknown, state: { id: number }) => {
    state.id++;
  })({ id });

  const { result, pending, error } = fetchData(
    payload({ id, request }) as Request,
  );

  return { result, pending, error, refetch };
});
