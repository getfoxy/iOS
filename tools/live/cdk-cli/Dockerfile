# cdk-cli from CDK's v0.18.0 tag, checked against the tag's commit.
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler pkg-config libssl-dev git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v0.18.0 https://github.com/cashubtc/cdk.git /cdk \
 && test "$(git -C /cdk rev-parse HEAD)" = d3dec24c784e8fec1fd65f853241c7a2261c7abd
WORKDIR /cdk
RUN cargo build --release --locked -p cdk-cli
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /cdk/target/release/cdk-cli /usr/local/bin/cdk-cli
ENTRYPOINT ["cdk-cli"]
