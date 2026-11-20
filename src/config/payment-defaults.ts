/**
 * The payment secrets outside production (`PAYMENT_KEY_SECRET`,
 * `PAYMENT_WEBHOOK_SECRET`). Public (they are in the repository): the mock
 * gateway protects nothing and moves no money. Kept free of decorators so
 * the Playwright tests can import them.
 */
export const DEV_PAYMENT_KEY_SECRET = 'mock-payment-key-secret';
export const DEV_PAYMENT_WEBHOOK_SECRET = 'mock-payment-webhook-secret';
