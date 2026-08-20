CREATE TABLE IF NOT EXISTS background_jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT background_jobs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT background_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT background_jobs_max_attempts_check CHECK (max_attempts > 0),
  CONSTRAINT background_jobs_payload_version_check CHECK (payload_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_active_dedupe_idx
  ON background_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING', 'RETRY_WAIT');

CREATE INDEX IF NOT EXISTS background_jobs_claim_idx
  ON background_jobs(status, available_at, priority DESC, created_at)
  WHERE status IN ('QUEUED', 'RETRY_WAIT', 'RUNNING');

CREATE INDEX IF NOT EXISTS background_jobs_lease_idx
  ON background_jobs(lease_expires_at)
  WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS background_jobs_type_status_idx
  ON background_jobs(type, status);

CREATE UNIQUE INDEX IF NOT EXISTS transcriptions_one_active_recording_language_idx
  ON transcriptions(recording_id, language)
  WHERE status IN ('PENDING', 'VALIDATING', 'FETCHING_RECORDING', 'SUBMITTING', 'PROCESSING', 'QUEUED', 'PROCESSING_AUDIO', 'IDENTIFYING_PARTICIPANTS', 'GENERATING_TRANSCRIPT', 'COMPLETED', 'COMPLETED_WITH_WARNINGS');

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_job_id UUID REFERENCES background_jobs(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS recording_egress_sessions (
  id UUID PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  room TEXT NOT NULL,
  egress_id TEXT UNIQUE,
  status TEXT NOT NULL,
  provider_status TEXT,
  output_object_key TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_egress_sessions_status_check CHECK (status IN ('PENDING', 'STARTING', 'RECORDING', 'STOPPING', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED', 'PENDING_RECONCILIATION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS recording_egress_one_active_per_room_idx
  ON recording_egress_sessions(room)
  WHERE status IN ('PENDING', 'STARTING', 'RECORDING', 'STOPPING', 'PROCESSING', 'PENDING_RECONCILIATION');

CREATE INDEX IF NOT EXISTS recording_egress_room_status_idx
  ON recording_egress_sessions(room, status);

CREATE TABLE IF NOT EXISTS facebook_live_sessions (
  id UUID PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  room TEXT NOT NULL,
  egress_id TEXT UNIQUE,
  provider_broadcast_id TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT facebook_live_sessions_status_check CHECK (status IN ('PENDING', 'STARTING', 'LIVE', 'STOPPING', 'STOPPED', 'FAILED', 'CANCELLED', 'PENDING_RECONCILIATION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS facebook_live_one_active_per_room_idx
  ON facebook_live_sessions(room)
  WHERE status IN ('PENDING', 'STARTING', 'LIVE', 'STOPPING', 'PENDING_RECONCILIATION');

CREATE INDEX IF NOT EXISTS facebook_live_room_status_idx
  ON facebook_live_sessions(room, status);
