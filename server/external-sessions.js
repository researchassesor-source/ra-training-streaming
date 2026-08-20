const crypto = require('node:crypto');
const db = require('./db');
const { sanitizeText } = require('./http-utils');

const memoryRecording = new Map();
const memoryFacebook = new Map();

function nowIso() { return new Date().toISOString(); }

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    meetingId: row.meeting_id || row.meetingId || null,
    room: row.room,
    egressId: row.egress_id || row.egressId || null,
    providerBroadcastId: row.provider_broadcast_id || row.providerBroadcastId || null,
    status: row.status,
    providerStatus: row.provider_status || row.providerStatus || null,
    outputObjectKey: row.output_object_key || row.outputObjectKey || null,
    startedAt: row.started_at || row.startedAt || null,
    endedAt: row.ended_at || row.endedAt || null,
    lastReconciledAt: row.last_reconciled_at || row.lastReconciledAt || null,
    lastErrorCode: row.last_error_code || row.lastErrorCode || null,
    lastErrorMessage: row.last_error_message || row.lastErrorMessage || null,
    metadata: row.metadata || {},
  };
}

async function beginRecording({ meetingId, room }) {
  const cleanRoom = sanitizeText(room, { field: 'room', min: 3, max: 80, required: true });
  if (!db.usingPostgres()) {
    const existing = [...memoryRecording.values()].find((item) => item.room === cleanRoom && ['PENDING', 'STARTING', 'RECORDING', 'STOPPING', 'PROCESSING', 'PENDING_RECONCILIATION'].includes(item.status));
    if (existing) return { session: publicSession(existing), created: false };
    const session = { id: crypto.randomUUID(), meetingId, room: cleanRoom, status: 'PENDING', createdAt: nowIso(), updatedAt: nowIso() };
    memoryRecording.set(session.id, session);
    return { session: publicSession(session), created: true };
  }
  const existing = await db.query(
    `SELECT * FROM recording_egress_sessions
     WHERE room = $1 AND status IN ('PENDING', 'STARTING', 'RECORDING', 'STOPPING', 'PROCESSING', 'PENDING_RECONCILIATION')
     ORDER BY created_at DESC LIMIT 1`,
    [cleanRoom]
  );
  if (existing.rows[0]) return { session: publicSession(existing.rows[0]), created: false };
  const result = await db.query(
    `INSERT INTO recording_egress_sessions (id, meeting_id, room, status)
     VALUES ($1, $2, $3, 'PENDING')
     RETURNING *`,
    [crypto.randomUUID(), meetingId || null, cleanRoom]
  );
  return { session: publicSession(result.rows[0]), created: true };
}

async function updateRecording(id, patch = {}) {
  if (!id) return null;
  if (!db.usingPostgres()) {
    const current = memoryRecording.get(id);
    if (!current) return null;
    Object.assign(current, patch, { updatedAt: nowIso() });
    return publicSession(current);
  }
  const result = await db.query(
    `UPDATE recording_egress_sessions
     SET egress_id = COALESCE($2, egress_id),
         status = COALESCE($3, status),
         provider_status = COALESCE($4, provider_status),
         output_object_key = COALESCE($5, output_object_key),
         started_at = COALESCE($6::timestamptz, started_at),
         ended_at = COALESCE($7::timestamptz, ended_at),
         last_reconciled_at = COALESCE($8::timestamptz, last_reconciled_at),
         last_error_code = $9,
         last_error_message = $10,
         metadata = COALESCE($11::jsonb, metadata),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, patch.egressId || null, patch.status || null, patch.providerStatus || null, patch.outputObjectKey || null, patch.startedAt || null, patch.endedAt || null, patch.lastReconciledAt || null, patch.lastErrorCode || null, patch.lastErrorMessage || null, patch.metadata ? JSON.stringify(patch.metadata) : null]
  );
  return publicSession(result.rows[0]);
}

async function beginFacebook({ meetingId, room }) {
  const cleanRoom = sanitizeText(room, { field: 'room', min: 3, max: 80, required: true });
  if (!db.usingPostgres()) {
    const existing = [...memoryFacebook.values()].find((item) => item.room === cleanRoom && ['PENDING', 'STARTING', 'LIVE', 'STOPPING', 'PENDING_RECONCILIATION'].includes(item.status));
    if (existing) return { session: publicSession(existing), created: false };
    const session = { id: crypto.randomUUID(), meetingId, room: cleanRoom, status: 'PENDING', createdAt: nowIso(), updatedAt: nowIso() };
    memoryFacebook.set(session.id, session);
    return { session: publicSession(session), created: true };
  }
  const existing = await db.query(
    `SELECT * FROM facebook_live_sessions
     WHERE room = $1 AND status IN ('PENDING', 'STARTING', 'LIVE', 'STOPPING', 'PENDING_RECONCILIATION')
     ORDER BY created_at DESC LIMIT 1`,
    [cleanRoom]
  );
  if (existing.rows[0]) return { session: publicSession(existing.rows[0]), created: false };
  const result = await db.query(
    `INSERT INTO facebook_live_sessions (id, meeting_id, room, status)
     VALUES ($1, $2, $3, 'PENDING')
     RETURNING *`,
    [crypto.randomUUID(), meetingId || null, cleanRoom]
  );
  return { session: publicSession(result.rows[0]), created: true };
}

async function updateFacebook(id, patch = {}) {
  if (!id) return null;
  if (!db.usingPostgres()) {
    const current = memoryFacebook.get(id);
    if (!current) return null;
    Object.assign(current, patch, { updatedAt: nowIso() });
    return publicSession(current);
  }
  const result = await db.query(
    `UPDATE facebook_live_sessions
     SET egress_id = COALESCE($2, egress_id),
         provider_broadcast_id = COALESCE($3, provider_broadcast_id),
         status = COALESCE($4, status),
         started_at = COALESCE($5::timestamptz, started_at),
         ended_at = COALESCE($6::timestamptz, ended_at),
         last_reconciled_at = COALESCE($7::timestamptz, last_reconciled_at),
         last_error_code = $8,
         last_error_message = $9,
         metadata = COALESCE($10::jsonb, metadata),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, patch.egressId || null, patch.providerBroadcastId || null, patch.status || null, patch.startedAt || null, patch.endedAt || null, patch.lastReconciledAt || null, patch.lastErrorCode || null, patch.lastErrorMessage || null, patch.metadata ? JSON.stringify(patch.metadata) : null]
  );
  return publicSession(result.rows[0]);
}

async function resetForTest() {
  memoryRecording.clear();
  memoryFacebook.clear();
}

module.exports = { beginFacebook, beginRecording, publicSession, resetForTest, updateFacebook, updateRecording };
