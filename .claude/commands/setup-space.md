Using `scripts/main.ts` we can create recipes and network them together in a space.

Each space has a unique <SPACENAME> and every recipe has a unique cause it is created against. The <RECIPE_PATH> folder where recipes are stored may vary based on the user, ask them before beginning space setup. You will have to kill these shell commands once the output is complete.



```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause gmail --recipeFile <RECIPE_PATH>/coralreef/gmail.tsx
```

When a recipe starts, it prints out its ID in the log. That ID can be used to network recipes together. e.g. if our above gmail recipe's ID is `baedreigjit5dhi5aogyxb5wqolep3m6cu7mbu4b5u7uk2c5o4k7brj2u2q` then:

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause email-list --recipeFile <RECIPE_PATH>/email-list.tsx --input '{"emails": @#baedreigjit5dhi5aogyxb5wqolep3m6cu7mbu4b5u7uk2c5o4k7brj2u2q/emails }'
```

Creates a list attached to the gmail recipe's data.

You will need to also create the `all-lists` and `all-pages` recipes. This is linked to the well-known ID of the `charms` list in any space `baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye`.

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause all-lists --recipeFile <RECIPE_PATH>/all-lists.tsx --input '{ "allCharms": @#baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye }'
```

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause all-pages --recipeFile <RECIPE_PATH>/all-pages.tsx --input '{ "allCharms": @#baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye }'
```

You can then add custom lists:

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause list-1 --recipeFile <RECIPE_PATH>/list.tsx
```

Or pages:

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACENAME> --cause page-1 --recipeFile <RECIPE_PATH>/page.tsx
```

And finally, you can configure the page manager:

```sh
deno run --allow-all scripts/main.ts --spaceName <SPACE> --cause page-man-1 --recipeFile <RECIPE_PATH>/page-manager.tsx --input '{ "lists": @#<ALL_LISTS_ID>/lists, "pages": @#<ALL_PAGES_ID>/pages }'
```
