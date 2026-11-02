#!/bin/sh
# Bridge binds to loopback only, so socat exposes it to the published container ports.
set -e
gpg --batch --passphrase '' --quick-generate-key bridge-test-keychain default default never 2>/dev/null
pass init bridge-test-keychain >/dev/null
socat TCP-LISTEN:11143,fork,reuseaddr TCP:127.0.0.1:1143 &
socat TCP-LISTEN:11025,fork,reuseaddr TCP:127.0.0.1:1025 &
fake-server --port 8080 >/tmp/fake.log 2>&1 &
until fake-client info >/tmp/info.json 2>/dev/null; do sleep 1; done
export BRIDGE_HOST_URL="$(jq -r '.HostURL // .hostURL' /tmp/info.json)"
FAKE_PASS="$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 24)"
export FAKE_PASS
fake-client user create --username qauser --password "$FAKE_PASS"
exec expect -f /login.exp
