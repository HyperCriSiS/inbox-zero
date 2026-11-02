# Proton Mail Bridge test setup

Builds the real Proton Mail Bridge from source and runs it against Proton's fake
API server from `go-proton-api`. No Proton account is needed, nothing reaches
Proton, and an installed Bridge on the same machine is not touched.

```bash
docker build -t iz-proton-bridge-qa docker/proton-bridge-test
docker run -d --name iz-bridge-qa -p 127.0.0.1:41143:11143 -p 127.0.0.1:41025:11025 iz-proton-bridge-qa
```

Once `docker logs iz-bridge-qa` shows the account configuration, take the Bridge
password from there and read the certificate from the running server:

```bash
openssl s_client -starttls imap -connect 127.0.0.1:41143 </dev/null 2>/dev/null | openssl x509 > bridge.crt
```

Then, with Postgres migrated:

```bash
IMAP_BRIDGE_CERT=$PWD/bridge.crt IMAP_BRIDGE_PASSWORD=<password> IMAP_ALLOW_PRIVATE_HOSTS=true pnpm test-integration imap-proton-bridge
```

## Limits

Bridge and its IMAP engine are real, the API behind them is not:

- The fake API drops the `Message-ID` of appended mail, so Bridge reports
  `<id@protonmail.internalid>` instead. Real accounts keep the original ID.
- Sync of a real mailbox, Proton's rate limits and real delivery are not covered.
