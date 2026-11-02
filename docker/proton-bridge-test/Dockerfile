FROM golang:1.26-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-dev libfido2-dev libcbor-dev pkg-config
RUN git clone -q --depth 1 --branch v3.27.1 https://github.com/ProtonMail/proton-bridge.git /src/bridge \
 && git clone -q https://github.com/ProtonMail/go-proton-api.git /src/gpa \
 && git -C /src/gpa checkout -q 8a62023d3e38
WORKDIR /src/bridge
# `build_qa` is what lets BRIDGE_HOST_URL point Bridge at the fake API.
RUN printf 'package bridge\n\nconst Credits = "qa"\n' > internal/bridge/credits.go \
 && go build -tags build_qa -o /out/bridge ./cmd/Desktop-Bridge/
WORKDIR /src/gpa
RUN go build -o /out/fake-server ./server/cmd/server && go build -o /out/fake-client ./server/cmd/client

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gnupg pass socat procps expect jq libsecret-1-0 libfido2-1 libcbor0.8
COPY --from=build /out/ /usr/local/bin/
COPY entry.sh login.exp /
RUN chmod +x /entry.sh && useradd -m bridge
USER bridge
WORKDIR /home/bridge
ENTRYPOINT ["/entry.sh"]
