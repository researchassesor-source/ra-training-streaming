CREATE TABLE IF NOT EXISTS livekit_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  room_name TEXT,
  participant_identity TEXT,
  event_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PROCESSING',
  error_code TEXT,
  CONSTRAINT livekit_webhook_events_status_check CHECK (status IN ('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  actor TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING',
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_keys_status_check CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  CONSTRAINT idempotency_keys_response_status_check CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599)
);

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS last_presence_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_presence_event_type TEXT,
  ADD COLUMN IF NOT EXISTS active_identity TEXT;

CREATE INDEX IF NOT EXISTS livekit_webhook_events_event_at_idx ON livekit_webhook_events(event_at);
CREATE INDEX IF NOT EXISTS livekit_webhook_events_room_name_idx ON livekit_webhook_events(room_name);
CREATE INDEX IF NOT EXISTS livekit_webhook_events_participant_identity_idx ON livekit_webhook_events(participant_identity);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS attendance_last_presence_event_at_idx ON attendance(last_presence_event_at);
