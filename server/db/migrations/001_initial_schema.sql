CREATE TABLE IF NOT EXISTS training_series (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  store_key TEXT NOT NULL UNIQUE,
  username TEXT PRIMARY KEY,
  password_hash TEXT,
  role TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER')),
  CONSTRAINT users_session_version_check CHECK (session_version >= 1)
);

CREATE TABLE IF NOT EXISTS meetings (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL UNIQUE,
  series_id TEXT REFERENCES training_series(id) ON DELETE SET NULL,
  session_number INTEGER,
  status TEXT,
  type TEXT,
  scheduled_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  CONSTRAINT meetings_status_check CHECK (status IS NULL OR status IN ('DRAFT', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED'))
);

CREATE TABLE IF NOT EXISTS room_configs (
  store_key TEXT NOT NULL UNIQUE,
  room TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  status TEXT,
  locked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS room_participant_access (
  room TEXT NOT NULL REFERENCES room_configs(room) ON DELETE CASCADE,
  participant_identity TEXT NOT NULL,
  meeting_role TEXT,
  microphone_grant TEXT,
  camera_grant TEXT,
  screen_grant TEXT,
  speaker_grant TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room, participant_identity)
);

CREATE TABLE IF NOT EXISTS invitations (
  store_key TEXT NOT NULL UNIQUE,
  token_hash TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  room TEXT,
  role TEXT,
  status TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  CONSTRAINT invitations_uses_check CHECK (uses >= 0),
  CONSTRAINT invitations_max_uses_check CHECK (max_uses IS NULL OR max_uses >= 1)
);

CREATE TABLE IF NOT EXISTS series_accesses (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE,
  series_id TEXT REFERENCES training_series(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  participant_key TEXT,
  role TEXT,
  status TEXT,
  is_general BOOLEAN NOT NULL DEFAULT false,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  CONSTRAINT series_accesses_usage_count_check CHECK (usage_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS series_accesses_one_active_general
  ON series_accesses(series_id, role)
  WHERE status = 'ACTIVE' AND is_general;

CREATE UNIQUE INDEX IF NOT EXISTS series_accesses_one_active_individual
  ON series_accesses(series_id, participant_key, role)
  WHERE status = 'ACTIVE' AND NOT is_general;

CREATE TABLE IF NOT EXISTS attendance (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES training_series(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  participant_key TEXT,
  join_count INTEGER NOT NULL DEFAULT 0,
  accumulated_ms BIGINT NOT NULL DEFAULT 0,
  active_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  UNIQUE (series_id, meeting_id, participant_key),
  CONSTRAINT attendance_join_count_check CHECK (join_count >= 0),
  CONSTRAINT attendance_accumulated_ms_check CHECK (accumulated_ms >= 0)
);

CREATE TABLE IF NOT EXISTS questions (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  room TEXT,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  status TEXT,
  pinned BOOLEAN NOT NULL DEFAULT false,
  vote_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS question_votes (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  participant_identity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, participant_identity)
);

CREATE TABLE IF NOT EXISTS speaker_requests (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  room TEXT,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  participant_identity TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS speaker_requests_one_active_per_participant
  ON speaker_requests(room, participant_identity)
  WHERE status IN ('PENDING', 'GRANTED');

CREATE TABLE IF NOT EXISTS chat_pins (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  room TEXT,
  message_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  action TEXT,
  actor TEXT,
  room TEXT,
  target TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS transcriptions (
  store_key TEXT NOT NULL UNIQUE,
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  recording_id TEXT,
  provider TEXT,
  language TEXT,
  status TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  CONSTRAINT transcriptions_progress_check CHECK (progress >= 0 AND progress <= 100)
);

CREATE INDEX IF NOT EXISTS meetings_series_id_idx ON meetings(series_id);
CREATE INDEX IF NOT EXISTS meetings_status_idx ON meetings(status);
CREATE INDEX IF NOT EXISTS meetings_scheduled_at_idx ON meetings(scheduled_at);
CREATE INDEX IF NOT EXISTS training_series_status_idx ON training_series(status);
CREATE INDEX IF NOT EXISTS invitations_room_idx ON invitations(room);
CREATE INDEX IF NOT EXISTS invitations_meeting_id_idx ON invitations(meeting_id);
CREATE INDEX IF NOT EXISTS invitations_status_idx ON invitations(status);
CREATE INDEX IF NOT EXISTS series_accesses_series_id_idx ON series_accesses(series_id);
CREATE INDEX IF NOT EXISTS series_accesses_status_idx ON series_accesses(status);
CREATE INDEX IF NOT EXISTS attendance_series_id_idx ON attendance(series_id);
CREATE INDEX IF NOT EXISTS attendance_meeting_id_idx ON attendance(meeting_id);
CREATE INDEX IF NOT EXISTS questions_room_idx ON questions(room);
CREATE INDEX IF NOT EXISTS questions_meeting_id_idx ON questions(meeting_id);
CREATE INDEX IF NOT EXISTS questions_status_idx ON questions(status);
CREATE INDEX IF NOT EXISTS speaker_requests_room_idx ON speaker_requests(room);
CREATE INDEX IF NOT EXISTS speaker_requests_status_idx ON speaker_requests(status);
CREATE INDEX IF NOT EXISTS chat_pins_room_idx ON chat_pins(room);
CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events(action);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events(actor);
CREATE INDEX IF NOT EXISTS audit_events_room_idx ON audit_events(room);
CREATE INDEX IF NOT EXISTS transcriptions_meeting_id_idx ON transcriptions(meeting_id);
CREATE INDEX IF NOT EXISTS transcriptions_recording_id_idx ON transcriptions(recording_id);
CREATE INDEX IF NOT EXISTS transcriptions_status_idx ON transcriptions(status);
