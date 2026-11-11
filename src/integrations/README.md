# Integrations

Adapters for external providers. Business modules depend on the interface, never on a provider's SDK.

Each integration is a folder containing:

- `<name>.provider.ts`: the interface and its injection token.
- `mock-<name>.provider.ts`: an in-memory implementation used in development and in every test.
- `<vendor>-<name>.provider.ts`: the real implementation, selected by configuration.
- `<name>.module.ts`: binds the token to the configured implementation.

| Interface | Purpose | Real implementation | Milestone |
|---|---|---|---|
| `MessagingProvider` | Email, SMS, WhatsApp | Not chosen. Interface and in-memory mock built | M1 |
| `StorageProvider` | Signed upload and download URLs for private documents | S3-compatible (assumed). Interface and local-disk mock built | M1 |
| `RoutingProvider` | Distance between two locations | Built-in great-circle with routing factor | M3 |
| `AirlineInventoryProvider` | Scheduled search, fare rules, revalidation, booking | Not chosen | M4 |
| `PaymentGatewayProvider` | Orders, signature verification, webhooks, refunds | Razorpay | M7 |

Every call to a real provider has a timeout, bounded retries for safe operations, and a defined fallback. Provider errors are mapped to our error codes and never passed through to clients.

## Mocks and development tools

The messaging and storage mocks come with development-only routes:

- `GET /api/v1/dev/outbox?to=<address>` lists what the messaging mock "sent" to an address, newest first. This is how a developer or a test reads a one-time code or an emailed link. Messages are held in memory, lost when the API restarts, and each one is also printed to the API log (`MockMessaging`, marked `[DEV ONLY, not sent]`) so a code can be read from the terminal.
- `PUT` and `GET /api/v1/dev/storage/:token` are where the storage mock's signed URLs point. The token is an HMAC-signed, expiring ticket, so the flow matches a real bucket: no session is involved in the transfer. Files are written under `STORAGE_DIR` (`.storage` by default, not committed).

These routes answer 404 unless `ENABLE_DEV_TOOLS=true` (`DevToolsGuard`). The same flag lets the mocks be used at all: without it, and with no real provider, the API refuses to start. The configuration refuses the flag when `NODE_ENV=production`, so production needs real providers.

When adding a real provider: bind it in the integration's module by configuration, keep the mock for development and tests, and move any check the mock does at upload time (content type by leading bytes, size) to where a real bucket can enforce it.
