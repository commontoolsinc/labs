export default {
  args: Deno.env.get("CI") ? ["--no-sandbox"] : [],
};
