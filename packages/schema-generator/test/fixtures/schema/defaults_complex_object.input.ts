interface Default<T, V> {}
interface SchemaRoot {
  config: Default<
    { theme: string; count: number },
    { theme: "dark"; count: 10 }
  >;
  user: Default<
    { name: string; settings: { notifications: boolean; email: string } },
    {
      name: "Anonymous";
      settings: { notifications: true; email: "user@example.com" };
    }
  >;
}
