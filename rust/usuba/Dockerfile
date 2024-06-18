FROM rust:1.76 as builder

ENV NODE_VERSION=20.13.1
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION} 
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="/root/.nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"

WORKDIR /build-root

COPY "./Cargo.toml" "./Cargo.lock" ./
COPY ./rust ./rust
COPY ./typescript ./typescript

RUN rustup target add wasm32-wasi
RUN cargo install wasm-tools wit-deps-cli

WORKDIR /build-root/typescript

RUN npm install -g @bytecodealliance/jco
RUN npm ci
RUN npm run build

WORKDIR /build-root

RUN cargo build --release --bin usuba

FROM node:latest

WORKDIR /usuba

EXPOSE 8080

RUN apt-get update && apt-get install -y libssl-dev ca-certificates
RUN npm install -g @bytecodealliance/componentize-js
RUN npm install -g @bytecodealliance/jco

COPY --from=builder /build-root/target/release/usuba /usr/bin/usuba

ENV RUST_LOG="debug"
ENV UPSTREAM="localhost:5173"

ENTRYPOINT ["/usr/bin/usuba"]