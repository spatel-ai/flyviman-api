# Integrations

Adapters for external providers. Business modules depend on the interface, never on a provider's SDK.

Each integration is a folder containing:

- `<name>.provider.ts`: the interface and its injection token.
- `mock-<name>.provider.ts`: an in-memory implementation used in development and in every test.
- `<vendor>-<name>.provider.ts`: the real implementation, selected by configuration.
- `<name>.module.ts`: binds the token to the configured implementation.

| Interface | Purpose | Real implementation | Milestone |
|---|---|---|---|
| `MessagingProvider` | Email, SMS, WhatsApp | Not chosen | M1 |
| `StorageProvider` | Signed upload and download URLs for private documents | S3-compatible (assumed) | M1 |
| `RoutingProvider` | Distance between two locations | Built-in great-circle with routing factor | M3 |
| `AirlineInventoryProvider` | Scheduled search, fare rules, revalidation, booking | Not chosen | M4 |
| `PaymentGatewayProvider` | Orders, signature verification, webhooks, refunds | Razorpay | M7 |

Every call to a real provider has a timeout, bounded retries for safe operations, and a defined fallback. Provider errors are mapped to our error codes and never passed through to clients.
