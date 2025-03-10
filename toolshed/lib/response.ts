export async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if ("error" in data) {
    throw new Error(data.error);
  }

  if (data.type === "json") {
    return data.body;
  }

  if (data instanceof Response) {
    throw new Error(data.statusText);
  }

  return null as never;
}
