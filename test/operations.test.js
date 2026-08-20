const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-32-characters';
process.env.INVITATION_HASH_SECRET = 'test-invitation-secret-with-more-than-32-characters';

const db = require('../server/db');
const localStore = require('../server/local-store');
const redis = require('../server/redis');
const backgroundJobs = require('../server/background-jobs');
const { createHealthRouter } = require('../server/routes/health.routes');
const { createShutdown } = require('../server/lifecycle');
const { createApp } = require('../server/app');
const { decodeCursor, encodeCursor, parseLimit } = require('../server/pagination');
const recordings = require('../server/recordings');
const auth = require('../server/auth');
const audit = require('../server/audit');
const transcriptions = require('../server/transcriptions');

function patch(target, key, value, patches) {
  patches.push([target, key, target[key]]);
  target[key] = value;
}

async function withPatches(setup, fn) {
  const patches = [];
  setup(patches);
  try {
    return await fn();
  } finally {
    for (const [target, key, original] of patches.reverse()) target[key] = original;
  }
}

async function withHealthApp(options, fn) {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('X-Request-ID', 'test-request-id');
    next();
  });
  app.use(createHealthRouter(options));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function healthyProbes(overrides = {}) {
  return {
    livekitProbe: async () => ({ configured: true, available: true }),
    storageProbe: async () => ({ configured: true, available: true, mode: 's3' }),
    transcriptionStatus: async () => ({ configured: false, available: false, status: 'disabled' }),
    recordingConfigured: true,
    ...overrides,
  };
}

test('API error responses expose request correlation without stack traces', async () => {
  const app = createApp({
    services: { roomService: {}, egressClient: {} },
    livekitProbe: async () => ({ configured: true, available: true }),
    storageProbe: async () => ({ configured: false, available: false }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/unknown-operational-route`);
    const body = await response.json();
    const requestId = response.headers.get('x-request-id');
    assert.equal(response.status, 404);
    assert.ok(requestId);
    assert.equal(body.requestId, requestId);
    assert.equal(body.code, 'NOT_FOUND');
    assert.doesNotMatch(JSON.stringify(body), /stack|Error:/i);
  });
});

test('/live is dependency-free while /ready and /health fail closed on core dependency outages', async () => {
  await withPatches((patches) => {
    patch(db, 'usingPostgres', () => true, patches);
    patch(db, 'ping', async () => { throw new Error('postgres down'); }, patches);
    patch(redis, 'hasRedis', () => false, patches);
    patch(backgroundJobs, 'diagnostics', async () => ({ queued: 0, failedRecent: 0 }), patches);
  }, async () => {
    let probeCalls = 0;
    await withHealthApp(healthyProbes({
      livekitProbe: async () => { probeCalls += 1; return { configured: true, available: true }; },
    }), async (baseUrl) => {
      const live = await fetch(`${baseUrl}/live`);
      assert.equal(live.status, 200);
      assert.equal((await live.json()).status, 'live');
      assert.equal(probeCalls, 0);

      const ready = await fetch(`${baseUrl}/ready`);
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).checks.postgres, 'unavailable');

      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 503);
      assert.equal((await health.json()).status, 'unhealthy');
    });
  });

  await withPatches((patches) => {
    patch(db, 'usingPostgres', () => false, patches);
    patch(redis, 'hasRedis', () => true, patches);
    patch(redis, 'ping', async () => { throw new Error('redis down'); }, patches);
    patch(redis, 'diagnostics', () => ({ configured: true, connected: false }), patches);
    patch(backgroundJobs, 'diagnostics', async () => ({ queued: 0, failedRecent: 0 }), patches);
  }, async () => {
    await withHealthApp(healthyProbes(), async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 503);
      assert.equal((await health.json()).services.redis.status, 'unavailable');
    });
  });
});

test('/ready ignores stale workers but /health reports a degraded operational state', async () => {
  await withPatches((patches) => {
    patch(db, 'usingPostgres', () => true, patches);
    patch(db, 'ping', async () => true, patches);
    patch(redis, 'hasRedis', () => false, patches);
    patch(backgroundJobs, 'diagnostics', async () => ({ queued: 0, failedRecent: 0, workerLastSeenAt: null }), patches);
  }, async () => {
    await withHealthApp(healthyProbes(), async (baseUrl) => {
      const ready = await fetch(`${baseUrl}/ready`);
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).status, 'ready');

      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.services.worker, 'stale');
    });
  });
});

test('shutdown drains HTTP, Redis and PostgreSQL once', async () => {
  const calls = { server: 0, redis: 0, postgres: 0, exit: [] };
  const done = new Promise((resolve) => {
    const shutdown = createShutdown({
      serverRef: () => ({ close: (callback) => { calls.server += 1; setImmediate(callback); } }),
      redis: { disconnect: async () => { calls.redis += 1; } },
      db: { closePool: async () => { calls.postgres += 1; } },
      exit: (code) => { calls.exit.push(code); resolve(); },
      timeoutMs: 500,
    });
    assert.equal(shutdown('SIGTERM', 0), true);
    assert.equal(shutdown('SIGTERM', 0), false);
  });
  await done;
  assert.deepEqual(calls, { server: 1, redis: 1, postgres: 1, exit: [0] });
});

test('pagination helpers validate bounded limits and opaque cursors', () => {
  assert.equal(parseLimit(undefined, { defaultLimit: 25, maxLimit: 100 }), 25);
  assert.equal(parseLimit('100', { defaultLimit: 25, maxLimit: 100 }), 100);
  assert.throws(() => parseLimit('101', { defaultLimit: 25, maxLimit: 100 }), /Límite/);
  assert.throws(() => parseLimit('abc', { defaultLimit: 25, maxLimit: 100 }), /Límite/);
  const cursor = encodeCursor({ updatedAt: '2030-01-01T00:00:00.000Z', id: 'abc' });
  assert.deepEqual(decodeCursor(cursor), { updatedAt: '2030-01-01T00:00:00.000Z', id: 'abc' });
  assert.throws(() => decodeCursor('not-base64-json'), /Cursor/);
});

test('PostgreSQL users listing uses one bounded query path', async () => {
  const queries = [];
  await withPatches((patches) => {
    patch(localStore, 'usesPostgres', () => true, patches);
    patch(db, 'query', async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [
          { data: { username: 'organizer-one', role: 'ORGANIZER', active: true, passwordHash: 'secret-hash' } },
          { data: { username: 'viewer-one', role: 'VIEWER', active: true, passwordHash: 'secret-hash' } },
        ],
      };
    }, patches);
  }, async () => {
    const users = await auth.listUsers();
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /SELECT data FROM users ORDER BY username ASC/);
    assert.ok(users.some((user) => user.username === 'organizer-one'));
    assert.equal(users.find((user) => user.username === 'organizer-one').passwordHash, undefined);
  });
});

test('PostgreSQL audit pagination is cursor-based and does not duplicate rows between pages', async () => {
  const calls = [];
  await withPatches((patches) => {
    patch(localStore, 'usesPostgres', () => true, patches);
    patch(db, 'query', async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            { data: { id: 'event-3', timestamp: '2030-01-03T00:00:00.000Z', action: 'USER_UPDATED' } },
            { data: { id: 'event-2', timestamp: '2030-01-02T00:00:00.000Z', action: 'USER_UPDATED' } },
          ],
        };
      }
      assert.match(sql, /\(timestamp, id\) </);
      assert.deepEqual(params, ['2030-01-03T00:00:00.000Z', 'event-3', 2]);
      return { rows: [{ data: { id: 'event-2', timestamp: '2030-01-02T00:00:00.000Z', action: 'USER_UPDATED' } }] };
    }, patches);
  }, async () => {
    const first = await audit.listEvents({ limit: 1, page: true });
    const second = await audit.listEvents({ limit: 1, page: true, cursor: first.nextCursor });
    assert.deepEqual(first.items.map((event) => event.id), ['event-3']);
    assert.deepEqual(second.items.map((event) => event.id), ['event-2']);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(calls.length, 2);
  });
});

test('PostgreSQL transcription summary list is bounded and omits heavy content', async () => {
  const queries = [];
  await withPatches((patches) => {
    patch(localStore, 'usesPostgres', () => true, patches);
    patch(db, 'query', async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [{
          data: {
            id: 'transcript-one',
            meetingId: 'meeting-one',
            recordingId: 'recordings/room-one/one.mp4',
            status: 'COMPLETED',
            segments: [{ text: 'Hola', startMs: 0, endMs: 1000 }],
            words: ['Hola'],
            providerMetadata: { requestId: 'provider-secret-shaped' },
          },
        }],
      };
    }, patches);
  }, async () => {
    const summaries = await transcriptions.listTranscriptSummaries({ meetingId: 'meeting-one', limit: 5 });
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /FROM transcriptions/);
    assert.deepEqual(queries[0].params, ['meeting-one', 5]);
    assert.equal(summaries[0].segments, undefined);
    assert.equal(summaries[0].words, undefined);
    assert.equal(summaries[0].providerMetadata, undefined);
    assert.equal(summaries[0].segmentCount, 1);
    assert.equal(summaries[0].wordCount, 1);
  });
});

test('PostgreSQL recordings listing is paginated and does not presign every row', async () => {
  const queries = [];
  await withPatches((patches) => {
    patch(db, 'query', async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            meeting_id: 'meeting-one',
            room: 'room-one',
            status: 'READY',
            output_object_key: 'recordings/room-one/one.mp4',
            metadata: { participants: ['A'] },
            updated_at: '2030-01-02T00:00:00.000Z',
            created_at: '2030-01-02T00:00:00.000Z',
            meeting_data: { title: 'Sesión uno', trainerName: 'Trainer', allowTranscription: true, status: 'COMPLETED' },
            transcript_data: { id: 'transcript-one', segments: [{ words: ['hola'] }], words: ['hola'] },
          },
          {
            id: '00000000-0000-4000-8000-000000000000',
            meeting_id: 'meeting-two',
            room: 'room-one',
            status: 'READY',
            output_object_key: 'recordings/room-one/two.mp4',
            metadata: {},
            updated_at: '2030-01-01T00:00:00.000Z',
            created_at: '2030-01-01T00:00:00.000Z',
            meeting_data: {},
            transcript_data: null,
          },
        ],
      };
    }, patches);
  }, async () => {
    const result = await recordings.listPostgresRecordings({ room: 'room-one', limit: 1 });
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /LEFT JOIN LATERAL/);
    assert.deepEqual(queries[0].params, ['room-one', 2]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].key, 'recordings/room-one/one.mp4');
    assert.equal(result.items[0].url, undefined);
    assert.ok(result.nextCursor);
  });
});

test('startup and build scripts remain fail-closed and reproducible', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(indexSource, /await db\.ping\(\)/);
  assert.match(indexSource, /await redis\.ping\(\)/);
  assert.match(indexSource, /process\.on\('SIGTERM'/);
  assert.match(indexSource, /unhandledRejection/);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.build, 'npm run build:track-processors');
  assert.match(manifest.scripts['build:track-processors'], /esbuild .*@livekit\/track-processors/);
});
