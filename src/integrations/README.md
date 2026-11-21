# Integrations

Adapters for external providers. Business modules depend on the interface, never on a provider's SDK.

Each integration is a folder containing:

- `<name>.provider.ts`: the interface and its injection token.
- `mock-<name>.provider.ts`: an in-memory implementation used in development and in every test.
- `<vendor>-<name>.provider.ts`: the real implementation, selected by configuration.
- `<name>.module.ts`: binds the token to the configured implementation.

| Interface                  | Purpose                                               | Real implementation                                                                  | Milestone |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| `MessagingProvider`        | Email, SMS, WhatsApp                                  | Not chosen. Mock (development) and sink (proof of concept) built                     | M1        |
| `StorageProvider`          | Signed upload and download URLs for private documents | S3-compatible (assumed). Local-disk store built (development, proof of concept)      | M1        |
| `RoutingProvider`          | Distance between two locations                        | Built-in great-circle with routing factor                                            | M5        |
| `AirlineInventoryProvider` | Scheduled search, fare rules, revalidation, booking   | Not chosen. Mock built (`AIRLINE_PROVIDER=mock`, deterministic Indian domestic data) | M6        |
| `PaymentGatewayProvider`   | Orders, signature verification, webhooks, refunds     | Razorpay (`PAYMENT_PROVIDER=razorpay`, built). Mock built and the default            | M9        |

Every call to a real provider has a timeout, bounded retries for safe operations, and a defined fallback. Provider errors are mapped to our error codes and never passed through to clients.

## Mocks and development tools

The messaging, storage and airline mocks come with development-only routes:

- `GET /api/v1/dev/outbox?to=<address>` lists what the messaging mock "sent" to an address, newest first. This is how a developer or a test reads a one-time code or an emailed link. Messages are held in memory, lost when the API restarts, and, with `NODE_ENV=development` only, each one is also printed to the API log (`MockMessaging`, marked `[DEV ONLY, not sent]`, recipient masked) so a code can be read from the terminal.
- `PUT` and `GET /api/v1/dev/storage/:token` are where the storage mock's signed URLs point. The token is an HMAC-signed, expiring ticket, so the flow matches a real bucket: no session is involved in the transfer. Files are written under `STORAGE_DIR` (`.storage` by default, not committed).

- `PUT /api/v1/dev/airline/behaviour` with `{ origin, destination, behaviour: "NORMAL" | "TIMEOUT" | "ERROR" }` (IATA codes) makes the airline mock never answer, or fail, for searches on that one route, so partial scheduled results can be tested; `NORMAL` restores it. Scoped to the route so parallel tests on other routes are unaffected.

These routes answer 404 unless `ENABLE_DEV_TOOLS=true` (`DevToolsGuard`). The same flag lets the mocks be used at all: without it, and with no real provider, the API refuses to start. The configuration refuses the flag when `NODE_ENV=production`, so production needs real providers.

**Development tools are for a developer's own machine and for automated tests only.** Do not turn them on for any server other people can reach, staging and demo servers included: the outbox route is public and returns password-reset and invitation links for any address. Such a server needs a real provider, or a sink provider that delivers only to an allow-listed mailbox, before it exists.

## WhatsApp (W4-8)

WhatsApp goes through the same messaging adapter, so with the mock it appears in `GET /api/v1/dev/outbox` like email and SMS. `WHATSAPP_ENABLED` controls it: default `true`, but `false` in production when unset; set it to `true` in production only once a provider and registered message templates exist. With it off, the notification matrix drops the WhatsApp channel and the other channels are unchanged.

## Proof-of-concept host (D-064)

A shared server with no real providers yet can start without development tools:

| Setting                   | Effect                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESSAGING_PROVIDER=sink` | `SinkMessagingProvider` accepts and discards every message and logs only its channel. No code or link is kept or exposed, so sign-up and password-reset codes never arrive; people sign in with seeded accounts (`SEED_DEMO_ACCOUNTS=true`). |
| `STORAGE_PROVIDER=local`  | The local-disk store and its signed routes run without development tools (`LocalStorageGuard`). Needs `API_PUBLIC_URL`. Files live on the server's disk and are lost when a host wipes it on redeploy.                                       |

`ENABLE_DEV_TOOLS` stays off there, so the outbox answers 404. This is for a proof of concept, not production: production needs a real messaging provider and object storage.

When adding a real provider: bind it in the integration's module by configuration, keep the mock for development and tests, and move any check the mock does at upload time (content type by leading bytes, size) to where a real bucket can enforce it.

## Payments

`PAYMENT_PROVIDER=mock` is the default and the only gateway used in tests. `PAYMENT_PROVIDER=razorpay` binds `RazorpayPaymentGatewayProvider` (`payment/payment.module.ts`). Payments must not go live until decisions 6, 7, 8 and 13 in `docs/open-decisions.md` are settled (Hard gate).

- `RazorpayPaymentGatewayProvider` calls Razorpay's REST API with `fetch` and Basic auth (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; no SDK): `POST /orders`, `GET /payments/:id`, `GET /orders/:id/payments`, `POST /payments/:id/refund` (keyed by our refund reference in `X-Refund-Idempotency`). Every call has a 10-second timeout; reads are tried twice, writes once (an order is never retried: Razorpay takes no idempotency key for orders and accepts a repeated receipt). A timeout, no connection, a 5xx, 401/403 (our keys refused), 409 or 429 is `UNAVAILABLE` (a refund stays `REQUESTED`, the sweep asks again); other 4xx are `INVALID_REQUEST` (Razorpay answers an unknown ID with 400). Only the operation, HTTP status and Razorpay's error code are logged, never a body, a key or Razorpay's description. IDs are checked before they go into a URL path. Answers are reduced to references, amounts, status and method type.
- The checkout signature is HMAC-SHA256 of `order_id|payment_id` with the key secret. Webhooks need `RAZORPAY_WEBHOOK_SECRET` (set with the webhook in the Razorpay Dashboard, never the mock's public development secret); without it every Razorpay webhook is refused as unsigned, payments settle through the status sweep (every 5 minutes, for payments open 15 minutes or more) and refunds wait for their notices. The webhook URL is `https://<api-host>/api/v1/webhooks/payments/razorpay`, for `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`.
- Payments must be captured automatically (Dashboard, payment capture settings): the adapter never captures, and an `authorized` payment is not final.
- Webhook bodies of both gateways are read by one parser (`payment/razorpay-webhook.ts`), and `PaymentEvent.payload` stores only an allowlist of the parsed event (`STORED_EVENT_FIELDS` in `modules/payments/payment-rules.ts`): references, amounts, status, method type and time, never email, contact, VPA or card fields.
- `MockPaymentGatewayProvider` mirrors Razorpay: the same webhook headers (`x-razorpay-signature`, `x-razorpay-event-id`) and payload shape, and real HMAC-SHA256 signatures (webhook: over the raw body with the webhook secret; checkout: over `order_id|payment_id` with the key secret). Its secrets are constants in the repository, so anyone can sign a mock webhook; it moves no money. Unlike the messaging and storage mocks it does not need `ENABLE_DEV_TOOLS`.
- It is deterministic (counter IDs, no clock) and in memory. `simulatePayment(orderId, 'success' | 'failure')` changes what `fetchPayment` reports at once and returns the signed webhook instead of sending it: post it later for a delayed webhook, or twice for a duplicate (same event ID). With `ENABLE_DEV_TOOLS`, `POST /api/v1/dev/payments/orders/:orderId/simulate` (`{ outcome }`) does the same in the running server and returns the checkout result and the signed webhook without sending them, so tests can lose a notice (the status sweep, `POST /api/v1/dev/jobs/payment-sweep`). The checkout can take an optional `method` (`card`, `upi`, `netbanking`; default `upi`): the method type is all the mock reports, never card details. `fetchOrderPayments(orderId)` lists the attempts on an order (Razorpay's `GET /orders/:id/payments`), which the sweep uses for a payment whose gateway payment id never reached us (W4-1). `createRefund` reserves the amount and answers `pending`; `simulateRefund(refundId, 'processed' | 'failed')` settles it (a failure gives the amount back) and returns the signed `refund.processed` or `refund.failed` notice, carrying our refund reference as `receipt`, without sending it; with `ENABLE_DEV_TOOLS`, `POST /api/v1/dev/payments/refunds/:refundId/simulate` (`{ outcome }`) does the same in the running server.
- Parsed webhooks keep references, amounts, statuses and the method type only; card and contact fields are dropped.
- `POST /api/v1/webhooks/payments/:provider` receives its body unparsed (a `Buffer`, `app.setup.ts`); every other route is parsed as JSON as before. The handler is a stub: it verifies the signature and answers 200, or 400 `WEBHOOK_SIGNATURE_INVALID`, and records nothing.
- `SETTLEMENT_MODE=manual` (default): settlements to operators are recorded and paid by hand. `razorpay_route` is reserved and refused at start-up until built (decision 8).
