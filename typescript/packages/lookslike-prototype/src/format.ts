import * as prettier from 'prettier'
import prettierPluginBabel from 'prettier/plugins/babel'
import prettierPluginEstree from "prettier/plugins/estree";

export async function format(code: string) {
  return await prettier.format(code, { semi: true, parser: "babel", plugins: [prettierPluginBabel, prettierPluginEstree] });
}
