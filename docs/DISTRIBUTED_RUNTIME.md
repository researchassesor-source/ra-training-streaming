# Distributed runtime

## Redis

Use one provider-neutral Redis connection string:

```env
REDIS_URL=
TEST_REDIS_URL=
```

`REDIS_URL` enables distributed rate limiting and short distributed locks. In `development` and `test`, the app can run without Redis and uses local memory for compatibility. In `preview` and `production`, Redis is required for distributed runtime startup.

Run the real Redis integration suite with:

```bash
npm run test:redis
```

If `TEST_REDIS_URL` is not configured, the command reports `NOT RUN`.

## LiveKit webhook

Register this endpoint in LiveKit:

```text
<APP_PUBLIC_URL>/api/webhooks/livekit
```

The endpoint is server-to-server and does not require CSRF. It validates the official LiveKit webhook signature with:

```env
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

Processed events:

- `room_started`
- `room_finished`
- `participant_joined`
- `participant_left`

Webhook deduplication is stored durably in PostgreSQL in `livekit_webhook_events`.

## PostgreSQL

Run:

```bash
npm run db:migrate
npm run db:status
npm run test:postgres
```

`002_distributed_resilience.sql` adds durable webhook events, HTTP idempotency keys, and attendance presence ordering fields.
