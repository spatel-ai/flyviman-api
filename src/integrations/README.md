# Integrations

Adapters for external providers. Business modules depend on the interface, never on a provider's SDK.

Each integration is a folder containing:

- `<name>.provider.ts`: the interface and its injection token.
- `mock-<name>.provider.ts`: an in-memory implementation used in development and in every test.
- `<vendor>-<name>.provider.ts`: the real implementation, selected by configuration.
- `<name>.module.ts`: binds the token to the configured implementation.

| Interface                  | Purpose                                               | Real implementation                                                             | Milestone |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| `MessagingProvider`        | Email, SMS, WhatsApp                                  | Not chosen. Mock (development) and sink (proof of concept) built                | M1        |
| `StorageProvider`          | Signed upload and download URLs for private documents | S3-compatible (assumed). Local-disk store built (development, proof of concept) | M1        |
| `RoutingProvider`          | Distance between two locations                        | Built-in great-circle with routing factor                                       | M5        |
| `AirlineInventoryProvider` | Scheduled search, fare rules, revalidation, booking   | Not chosen                                                                      | M6        |
| `PaymentGatewayProvider`   | Orders, signature verification, webhooks, refunds     | Razorpay (not built). Mock built; the only value of `PAYMENT_PROVIDER`          | M9        |

Every call to a real provider has a timeout, bounded retries for safe operations, and a defined fallback. Provider errors are mapped to our error codes and never passed through to clients.

## Mocks and development tools

The messaging and storage mocks come with development-only routes:

- `GET /api/v1/dev/outbox?to=<address>` lists what the messaging mock "sent" to an address, newest first. This is how a developer or a test reads a one-time code or an emailed link. Messages are held in memory, lost when the API restarts, and, with `NODE_ENV=development` only, each one is also printed to the API log (`MockMessaging`, marked `[DEV ONLY, not sent]`, recipient masked) so a code can be read from the terminal.
- `PUT` and `GET /api/v1/dev/storage/:token` are where the storage mock's signed URLs point. The token is an HMAC-signed, expiring ticket, so the flow matches a real bucket: no session is involved in the transfer. Files are written under `STORAGE_DIR` (`.storage` by default, not committed).

These routes answer 404 unless `ENABLE_DEV_TOOLS=true` (`DevToolsGuard`). The same flag lets the mocks be used at all: without it, and with no real provider, the API refuses to start. The configuration refuses the flag when `NODE_ENV=production`, so production needs real providers.

**Development tools are for a developer's own machine and for automated tests only.** Do not turn them on for any server other people can reach, staging and demo servers included: the outbox route is public and returns password-reset and invitation links for any address. Such a server needs a real provider, or a sink provider that delivers only to an allow-listed mailbox, before it exists.

## Proof-of-concept host (D-064)

A shared server with no real providers yet can start without development tools:

| Setting                   | Effect                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESSAGING_PROVIDER=sink` | `SinkMessagingProvider` accepts and discards every message and logs only its channel. No code or link is kept or exposed, so sign-up and password-reset codes never arrive; people sign in with seeded accounts (`SEED_DEMO_ACCOUNTS=true`). |
| `STORAGE_PROVIDER=local`  | The local-disk store and its signed routes run without development tools (`LocalStorageGuard`). Needs `API_PUBLIC_URL`. Files live on the server's disk and are lost when a host wipes it on redeploy.                                       |

`ENABLE_DEV_TOOLS` stays off there, so the outbox answers 404. This is for a proof of concept, not production: production needs a real messaging provider and object storage.

When adding a real provider: bind it in the integration's module by configuration, keep the mock for development and tests, and move any check the mock does at upload time (content type by leading bytes, size) to where a real bucket can enforce it.

## Payments (mock only)

`PAYMENT_PROVIDER=mock` is the only accepted value: real payments are impossible in this build, and must stay so until decisions 6, 7, 8 and 13 in `docs/open-decisions.md` are settled (Hard gate). Razorpay will be one more adapter bound in `payment/payment.module.ts`.

- `MockPaymentGatewayProvider` mirrors Razorpay: the same webhook headers (`x-razorpay-signature`, `x-razorpay-event-id`) and payload shape, and real HMAC-SHA256 signatures (webhook: over the raw body with the webhook secret; checkout: over `order_id|payment_id` with the key secret). Its secrets are constants in the repository, so anyone can sign a mock webhook; it moves no money. Unlike the messaging and storage mocks it does not need `ENABLE_DEV_TOOLS`.
- It is deterministic (counter IDs, no clock) and in memory. `simulatePayment(orderId, 'success' | 'failure')` changes what `fetchPayment` reports at once and returns the signed webhook instead of sending it: post it later for a delayed webhook, or twice for a duplicate (same event ID).
- Parsed webhooks keep references and amounts only; card and contact fields are dropped.
- `POST /api/v1/webhooks/payments/:provider` receives its body unparsed (a `Buffer`, `app.setup.ts`); every other route is parsed as JSON as before. The handler is a stub: it verifies the signature and answers 200, or 400 `WEBHOOK_SIGNATURE_INVALID`, and records nothing.
- `SETTLEMENT_MODE=manual` (default): settlements to operators are recorded and paid by hand. `razorpay_route` is reserved and refused at start-up until built (decision 8).
