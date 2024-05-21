FROM rust:1.75 as builder

WORKDIR /build-root

COPY "./Cargo.toml" "./Cargo.lock" ./
COPY ./rust ./rust
RUN cargo build --release --bin usuba

FROM node:latest

WORKDIR /usuba

EXPOSE 8888

RUN apt-get update && apt-get install -y libssl-dev ca-certificates
RUN npm install -g @bytecodealliance/jco

COPY --from=builder /build-root/target/release/usuba /usr/bin/usuba

ENV RUST_LOG="debug"

ENTRYPOINT ["/usr/bin/usuba"]