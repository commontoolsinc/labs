## Local Usuba Setup

Install some environment dependencies:

```sh
cargo install wit-deps-cli wasm-tools
rustup target add wasm32-wasi wasm32-unknown-unknown

npm install -g @bytecodealliance/jco
npm install -g @bytecodealliance/componentize-js

pip install componentize-py
```

On a Mac, also do this also:

```sh
brew install wget gsed
```

Set up an NPM project (using whatever stack) in `/typescript/packages` and add `@commontools/runtime` to your dependencies:

```sh
mkdir -p ./typescript/packages/my-project
cd ./typescript/packages/my-project

# Actually, better to copy a package.json from another package
echo '{"type": "module"}' > ./package.json
npm install --save @commontools/runtime
```

Get a web server going and note the `PORT` it is running on.

In another terminal, get `usuba` running:

```sh
cd ./rust/usuba
UPSTREAM=localhost:$PORT cargo run --bin usuba
```

Open your browser to http://localhost:8080. You should see whatever you would expect to see from the first web server you started.
