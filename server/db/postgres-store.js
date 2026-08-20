const { AppError } = require('../http-utils');
const db = require('./index');

const TABLES = Object.freeze({
  users: 'users',
  meetings: 'meetings',
  'training-series': 'training_series',
  invitations: 'invitations',
  'series-accesses': 'series_accesses',
  rooms: 'room_configs',
  attendance: 'attendance',
  questions: 'questions',
  'speaker-requests': 'speaker_requests',
  'chat-pins': 'chat_pins',
  audit: 'audit_events',
  transcriptions: 'transcriptions',
});

function tableFor(section) {
  const table = TABLES[section];
  if (!table) throw new AppError(500, `Sección de datos no soportada en PostgreSQL: ${section}`, 'DATA_BACKEND_ERROR');
  return table;
}

function asIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedKey(section, key, data = {}) {
  if (section === 'questions' || section === 'speaker-requests' || section === 'chat-pins') return String(data.id || key).split('/').pop();
  return String(key);
}

function common(data) {
  return {
    id: data.id || null,
    room: data.room || null,
    meetingId: data.meetingId || null,
    seriesId: data.seriesId || null,
    status: data.status || null,
    createdAt: asIso(data.createdAt || data.timestamp || data.joinedAt || data.requestedAt),
    updatedAt: asIso(data.updatedAt || data.lastUsedAt || data.lastJoinedAt || data.resolvedAt),
  };
}

function projection(section, key, data) {
  const c = common(data);
  switch (section) {
    case 'users':
      return {
        store_key: String(data.username || key).toLowerCase(),
        username: String(data.username || key).toLowerCase(),
        password_hash: data.passwordHash || null,
        role: data.role || 'ORGANIZER',
        active: data.active !== false,
        session_version: Number.isInteger(data.sessionVersion) ? data.sessionVersion : 1,
        created_at: asIso(data.createdAt),
        updated_at: asIso(data.updatedAt),
        last_login_at: asIso(data.lastLoginAt),
      };
    case 'meetings':
      return {
        store_key: String(data.room || key),
        id: data.id,
        room: data.room || key,
        series_id: data.seriesId || null,
        session_number: data.sessionNumber || null,
        status: data.status || null,
        type: data.type || data.meetingType || null,
        scheduled_at: asIso(data.scheduledAt),
        starts_at: asIso(data.startedAt),
        ends_at: asIso(data.endsAt),
        deleted_at: asIso(data.deletedAt),
        created_at: asIso(data.createdAt),
        updated_at: asIso(data.updatedAt),
      };
    case 'training-series':
      return { store_key: String(data.id || key), id: data.id || key, status: data.status || null, created_at: asIso(data.createdAt), updated_at: asIso(data.updatedAt) };
    case 'invitations':
      return {
        store_key: String(data.tokenHash || key),
        token_hash: data.tokenHash || key,
        meeting_id: data.meetingId || null,
        room: data.room || null,
        role: data.role || null,
        status: data.status || null,
        uses: Number(data.uses || 0),
        max_uses: data.maxUses === undefined || data.maxUses === null ? null : Number(data.maxUses),
        expires_at: asIso(data.expiresAt),
        revoked_at: asIso(data.revokedAt),
        created_at: asIso(data.createdAt),
        updated_at: asIso(data.updatedAt || data.lastUsedAt),
      };
    case 'series-accesses':
      return {
        store_key: String(data.id || key),
        id: data.id || key,
        token_hash: data.tokenHash || null,
        series_id: data.seriesId || null,
        meeting_id: data.meetingId || null,
        participant_key: data.participantKey || null,
        role: data.meetingRole || data.role || null,
        status: data.status || null,
        is_general: Boolean(data.general || data.isGeneral || data.accessType === 'GENERAL'),
        usage_count: Number(data.usageCount || 0),
        created_at: asIso(data.createdAt),
        updated_at: asIso(data.updatedAt || data.lastUsedAt),
      };
    case 'rooms':
      return {
        store_key: String(data.room || key),
        room: data.room || key,
        meeting_id: data.meetingId || null,
        status: data.status || null,
        locked: Boolean(data.locked),
        created_at: asIso(data.createdAt),
        updated_at: asIso(data.updatedAt || data.lockedAt || data.revokedAt),
      };
    case 'attendance':
      return {
        store_key: String(data.id || key),
        id: data.id || key,
        series_id: data.seriesId || null,
        meeting_id: data.meetingId || null,
        participant_key: data.participantKey || null,
        join_count: Number(data.joinCount || 0),
        accumulated_ms: Number(data.accumulatedMs || 0),
        active_since: asIso(data.activeSince),
        created_at: asIso(data.createdAt || data.firstJoinedAt),
        updated_at: asIso(data.updatedAt || data.lastLeftAt || data.lastJoinedAt),
      };
    case 'questions':
      return {
        store_key: normalizedKey(section, key, data),
        id: data.id || normalizedKey(section, key, data),
        room: data.room || null,
        meeting_id: data.meetingId || null,
        status: data.status || null,
        pinned: Boolean(data.pinned),
        vote_count: Array.isArray(data.voters) ? data.voters.length : Number(data.voteCount || 0),
        created_at: asIso(data.createdAt || data.askedAt),
        updated_at: asIso(data.updatedAt || data.answeredAt),
      };
    case 'speaker-requests':
      return {
        store_key: normalizedKey(section, key, data),
        id: data.id || normalizedKey(section, key, data),
        room: data.room || null,
        meeting_id: data.meetingId || null,
        participant_identity: data.participantIdentity || null,
        status: data.status || null,
        created_at: asIso(data.createdAt || data.requestedAt),
        updated_at: asIso(data.updatedAt || data.resolvedAt),
      };
    case 'chat-pins':
      return { store_key: normalizedKey(section, key, data), id: data.id || normalizedKey(section, key, data), room: data.room || null, message_id: data.messageId || null, created_at: asIso(data.createdAt || data.pinnedAt), updated_at: asIso(data.updatedAt) };
    case 'audit':
      return { store_key: String(data.id || key), id: data.id || key, timestamp: asIso(data.timestamp) || new Date().toISOString(), action: data.action || null, actor: data.actor || null, room: data.room || null, target: data.target || null, metadata: data.metadata || {} };
    case 'transcriptions':
      return { store_key: String(data.id || key), id: data.id || key, meeting_id: data.meetingId || null, recording_id: data.recordingId || null, provider: data.provider || null, language: data.language || null, status: data.status || null, progress: Math.trunc(Number(data.progress || 0)), created_at: asIso(data.createdAt), updated_at: asIso(data.updatedAt) };
    default:
      return { store_key: String(key), ...c };
  }
}

function paramsFrom(object, names) {
  return names.map((name) => object[name] === undefined ? null : object[name]);
}

async function writeJson(section, key, data, client = db.getPool()) {
  const table = tableFor(section);
  const p = projection(section, key, data);
  const names = Object.keys(p);
  const values = paramsFrom(p, names);
  const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
  const updates = names.filter((name) => name !== 'store_key').map((name) => `${name} = EXCLUDED.${name}`).join(', ');
  await client.query(
    `INSERT INTO ${table} (${names.join(', ')}, data)
     VALUES (${placeholders}, $${names.length + 1}::jsonb)
     ON CONFLICT (store_key) DO UPDATE SET ${updates}, data = EXCLUDED.data`,
    [...values, JSON.stringify(data)]
  );
  await syncAuxiliary(section, p, data, client);
  return data;
}

async function syncAuxiliary(section, projectionRow, data, client) {
  if (section === 'questions' && Array.isArray(data.voters) && projectionRow.id) {
    await client.query('DELETE FROM question_votes WHERE question_id = $1', [projectionRow.id]);
    for (const voter of data.voters) {
      await client.query('INSERT INTO question_votes (question_id, participant_identity) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectionRow.id, String(voter)]);
    }
  }
  if (section === 'rooms' && data && typeof data === 'object') {
    await client.query('DELETE FROM room_participant_access WHERE room = $1', [projectionRow.room]);
    const identities = new Set([
      ...Object.keys(data.speakerGrants || {}),
      ...Object.keys(data.roleOverrides || {}),
      ...Object.keys(data.mediaGrants || {}),
    ]);
    for (const identity of identities) {
      const grants = data.mediaGrants?.[identity] || {};
      await client.query(
        `INSERT INTO room_participant_access (
          room, participant_identity, meeting_role, microphone_grant, camera_grant, screen_grant, speaker_grant, updated_at, updated_by, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9::jsonb)`,
        [
          projectionRow.room,
          identity,
          data.roleOverrides?.[identity]?.meetingRole || null,
          grants.microphone || null,
          grants.camera || null,
          grants.screen || null,
          data.speakerGrants?.[identity] ? 'true' : null,
          grants.updatedBy || data.roleOverrides?.[identity]?.updatedBy || data.speakerGrants?.[identity]?.grantedBy || null,
          JSON.stringify({
            media: grants,
            role: data.roleOverrides?.[identity] || null,
            speaker: data.speakerGrants?.[identity] || null,
          }),
        ]
      );
    }
  }
}

async function readJson(section, key, client = db.getPool()) {
  const table = tableFor(section);
  const normalized = normalizedKey(section, key);
  const result = await client.query(`SELECT data FROM ${table} WHERE store_key = $1`, [normalized]);
  return result.rows[0]?.data;
}

async function listJson(section, client = db.getPool()) {
  const table = tableFor(section);
  const result = await client.query(`SELECT data FROM ${table} ORDER BY created_at NULLS LAST, store_key`);
  return result.rows.map((row) => row.data);
}

async function deleteJson(section, key, client = db.getPool()) {
  const table = tableFor(section);
  const normalized = normalizedKey(section, key);
  const result = await client.query(`DELETE FROM ${table} WHERE store_key = $1`, [normalized]);
  return result.rowCount > 0;
}

module.exports = {
  deleteJson,
  listJson,
  readJson,
  tableFor,
  writeJson,
};
