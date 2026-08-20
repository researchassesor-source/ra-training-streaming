CREATE INDEX IF NOT EXISTS meetings_status_scheduled_at_idx
  ON meetings(status, scheduled_at);

CREATE INDEX IF NOT EXISTS meetings_created_at_idx
  ON meetings(created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_action_timestamp_idx
  ON audit_events(action, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_actor_timestamp_idx
  ON audit_events(actor, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_room_timestamp_idx
  ON audit_events(room, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS transcriptions_meeting_created_at_idx
  ON transcriptions(meeting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS transcriptions_status_created_at_idx
  ON transcriptions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS recording_egress_meeting_id_idx
  ON recording_egress_sessions(meeting_id);

CREATE INDEX IF NOT EXISTS recording_egress_updated_at_idx
  ON recording_egress_sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS facebook_live_meeting_id_idx
  ON facebook_live_sessions(meeting_id);

CREATE INDEX IF NOT EXISTS livekit_webhook_events_room_event_at_idx
  ON livekit_webhook_events(room_name, event_at DESC);

CREATE INDEX IF NOT EXISTS livekit_webhook_events_status_event_at_idx
  ON livekit_webhook_events(status, event_at DESC);

CREATE INDEX IF NOT EXISTS background_jobs_status_available_priority_idx
  ON background_jobs(status, available_at, priority DESC, created_at);
