const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DeepgramTranscriptionProvider,
  normalizeDeepgramResponse,
} = require('../server/transcription-providers/deepgram');

const API_URL = 'https://api.deepgram.com/v1/listen';
const API_KEY = 'deepgram-test-key-never-real';
const recording = {
  id: 'recordings/reunion-qa/audio.mp4',
  status: 'READY',
  available: true,
  size: 4_096,
  durationSeconds: 8,
  url: 'https://preview-recordings.r2.cloudflarestorage.com/recordings/reunion-qa/audio.mp4?X-Amz-Signature=temporary-test-signature',
};

function deepgramPayload() {
  return {
    metadata: {
      request_id: 'request-qa-123',
      duration: 6.4,
      created: '2030-07-30T15:00:00.000Z',
      models: ['nova-3'],
    },
    results: {
      channels: [{ alternatives: [{
        transcript: 'Hola equipo. Gracias por participar.',
        confidence: 0.95,
        words: [
          { word: 'hola', punctuated_word: 'Hola', start: 0, end: 0.4, confidence: 0.98, speaker: 0 },
          { word: 'equipo', punctuated_word: 'equipo.', start: 0.4, end: 0.9, confidence: 0.96, speaker: 0 },
          { word: 'gracias', punctuated_word: 'Gracias', start: 2, end: 2.5, confidence: 0.94, speaker: 1 },
          { word: 'por', punctuated_word: 'por', start: 2.5, end: 2.7, confidence: 0.93, speaker: 1 },
          { word: 'participar', punctuated_word: 'participar.', start: 2.7, end: 3.4, confidence: 0.95, speaker: 1 },
        ],
        paragraphs: { paragraphs: [{ speaker: 0, sentences: [{ text: 'Hola equipo.', start: 0, end: 0.9 }] }, { speaker: 1, sentences: [{ text: 'Gracias por participar.', start: 2, end: 3.4 }] }] },
      }] }],
      utterances: [
        { id: 'utt-1', start: 0, end: 0.9, confidence: 0.97, channel: 0, transcript: 'Hola equipo.', speaker: 0, words: [
          { word: 'hola', punctuated_word: 'Hola', start: 0, end: 0.4, confidence: 0.98, speaker: 0 },
          { word: 'equipo', punctuated_word: 'equipo.', start: 0.4, end: 0.9, confidence: 0.96, speaker: 0 },
        ] },
        { id: 'utt-2', start: 2, end: 3.4, confidence: 0.94, channel: 0, transcript: 'Gracias por participar.', speaker: 1, words: [
          { word: 'gracias', punctuated_word: 'Gracias', start: 2, end: 2.5, confidence: 0.94, speaker: 1 },
          { word: 'por', punctuated_word: 'por', start: 2.5, end: 2.7, confidence: 0.93, speaker: 1 },
          { word: 'participar', punctuated_word: 'participar.', start: 2.7, end: 3.4, confidence: 0.95, speaker: 1 },
        ] },
      ],
    },
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function providerWith(fetchImpl, overrides = {}) {
  return new DeepgramTranscriptionProvider({
    enabled: true,
    apiUrl: API_URL,
    apiKey: API_KEY,
    allowedHosts: new Set(['api.deepgram.com']),
    productionLike: false,
    retryMax: 0,
    timeoutMs: 100,
    fetchImpl,
    sleepImpl: async () => {},
    ...overrides,
  });
}

async function waitForTerminal(provider, jobId, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await provider.getJobStatus(jobId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('El trabajo simulado no termin\u00f3 a tiempo');
}

test('Deepgram provider sends the secure official contract and normalizes Spanish diarization', async () => {
  let captured;
  const provider = providerWith(async (url, options) => {
    captured = { url, options };
    return jsonResponse(deepgramPayload());
  });
  const created = await provider.createJob({ recording, language: 'es' });
  const state = await waitForTerminal(provider, created.providerJobId);
  assert.equal(state.status, 'COMPLETED');
  const result = await provider.getTranscript(created.providerJobId);
  assert.equal(result.provider, 'deepgram');
  assert.equal(result.language, 'es');
  assert.equal(result.providerRequestId, 'request-qa-123');
  assert.deepEqual(result.segments.map((segment) => segment.speakerLabel), ['Hablante 1', 'Hablante 2']);
  assert.deepEqual(result.segments.map((segment) => segment.speakerId), ['speaker-0', 'speaker-1']);
  assert.equal(result.words.length, 5);
  assert.equal(result.words[0].start, 0);
  assert.equal(result.words[4].end, 3.4);
  assert.equal(captured.options.headers.Authorization, `Token ${API_KEY}`);
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(JSON.parse(captured.options.body), { url: recording.url });
  const requestUrl = new URL(captured.url);
  assert.equal(requestUrl.origin + requestUrl.pathname, API_URL);
  assert.equal(requestUrl.searchParams.get('language'), 'es');
  assert.equal(requestUrl.searchParams.get('model'), 'nova-3');
  assert.equal(requestUrl.searchParams.get('diarize_model'), 'latest');
  assert.equal(requestUrl.searchParams.get('smart_format'), 'true');
  assert.equal(requestUrl.searchParams.get('utterances'), 'true');
  assert.equal(requestUrl.searchParams.get('paragraphs'), 'true');
  assert.equal(requestUrl.searchParams.get('punctuate'), 'true');
});

test('normalization falls back safely when optional Deepgram structures are absent', async (t) => {
  await t.test('without paragraphs, utterances remain authoritative', () => {
    const payload = deepgramPayload();
    delete payload.results.channels[0].alternatives[0].paragraphs;
    assert.equal(normalizeDeepgramResponse(payload).segments.length, 2);
  });
  await t.test('without utterances, paragraphs produce timestamped segments', () => {
    const payload = deepgramPayload();
    delete payload.results.utterances;
    assert.deepEqual(normalizeDeepgramResponse(payload).segments.map((segment) => segment.speakerId), ['speaker-0', 'speaker-1']);
  });
  await t.test('without utterances or paragraphs, words are grouped by speaker', () => {
    const payload = deepgramPayload();
    delete payload.results.utterances;
    delete payload.results.channels[0].alternatives[0].paragraphs;
    assert.equal(normalizeDeepgramResponse(payload).segments.length, 2);
  });
  await t.test('without words, utterances still produce a usable transcript', () => {
    const payload = deepgramPayload();
    delete payload.results.channels[0].alternatives[0].words;
    payload.results.utterances.forEach((utterance) => { delete utterance.words; });
    const result = normalizeDeepgramResponse(payload);
    assert.equal(result.words.length, 0);
    assert.equal(result.segments.length, 2);
  });
});

test('empty, invalid JSON, invalid content type and oversized responses fail safely', async (t) => {
  const cases = [
    ['empty transcript', () => jsonResponse({ metadata: {}, results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] } })],
    ['invalid JSON', () => new Response('{invalid', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['invalid content type', () => new Response('<html>no</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['oversized response', () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' } })],
  ];
  for (const [name, responseFactory] of cases) {
    await t.test(name, async () => {
      const provider = providerWith(async () => responseFactory(), { maxResponseBytes: 512 });
      const created = await provider.createJob({ recording, language: 'es' });
      const state = await waitForTerminal(provider, created.providerJobId);
      assert.equal(state.status, 'FAILED');
      assert.equal(state.errorCode, 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
      assert.doesNotMatch(JSON.stringify(state), new RegExp(API_KEY));
      assert.doesNotMatch(JSON.stringify(state), /X-Amz-Signature/);
    });
  }
});

test('Deepgram HTTP errors map to actionable safe codes without retries for authentication', async (t) => {
  const cases = new Map([
    [400, 'TRANSCRIPTION_DEEPGRAM_BAD_REQUEST'],
    [401, 'TRANSCRIPTION_DEEPGRAM_AUTH_FAILED'],
    [403, 'TRANSCRIPTION_DEEPGRAM_AUTH_FAILED'],
    [404, 'TRANSCRIPTION_DEEPGRAM_BAD_REQUEST'],
    [413, 'TRANSCRIPTION_RECORDING_TOO_LARGE'],
    [415, 'TRANSCRIPTION_AUDIO_UNSUPPORTED'],
    [422, 'TRANSCRIPTION_DEEPGRAM_BAD_REQUEST'],
    [429, 'TRANSCRIPTION_DEEPGRAM_RATE_LIMITED'],
    [500, 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE'],
    [502, 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE'],
    [503, 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE'],
    [504, 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE'],
  ]);
  for (const [status, errorCode] of cases) {
    await t.test(String(status), async () => {
      let calls = 0;
      const provider = providerWith(async () => { calls += 1; return jsonResponse({ err_code: status }, { status }); });
      const created = await provider.createJob({ recording, language: 'es' });
      const state = await waitForTerminal(provider, created.providerJobId);
      assert.equal(state.status, 'FAILED');
      assert.equal(state.errorCode, errorCode);
      assert.equal(calls, 1);
    });
  }
});

test('429 honors Retry-After and retryable 5xx use bounded backoff', async () => {
  const sleeps = [];
  let calls = 0;
  const provider = providerWith(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, { status: 429, headers: { 'Retry-After': '2' } });
    if (calls === 2) return jsonResponse({}, { status: 503 });
    return jsonResponse(deepgramPayload());
  }, { retryMax: 2, sleepImpl: async (delay) => { sleeps.push(delay); } });
  const created = await provider.createJob({ recording, language: 'es' });
  assert.equal((await waitForTerminal(provider, created.providerJobId)).status, 'COMPLETED');
  assert.deepEqual(sleeps, [2_000, 1_000]);
  assert.equal(calls, 3);
});

test('timeouts abort the request and expose no implementation details', async () => {
  const provider = providerWith((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }), { timeoutMs: 10 });
  const created = await provider.createJob({ recording, language: 'es' });
  const state = await waitForTerminal(provider, created.providerJobId);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.errorCode, 'TRANSCRIPTION_DEEPGRAM_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(state), /AbortError|deepgram-test-key/);
});

test('timeout covers a stalled response body and cancellation interrupts retry backoff', async (t) => {
  await t.test('stalled body', async () => {
    const provider = providerWith(async (_url, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"metadata":'));
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, { timeoutMs: 10 });
    const created = await provider.createJob({ recording, language: 'es' });
    const state = await waitForTerminal(provider, created.providerJobId);
    assert.equal(state.status, 'FAILED');
    assert.equal(state.errorCode, 'TRANSCRIPTION_DEEPGRAM_TIMEOUT');
  });

  await t.test('retry backoff', async () => {
    let calls = 0;
    const provider = providerWith(async () => {
      calls += 1;
      return jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } });
    }, { retryMax: 2, sleepImpl: () => new Promise(() => {}) });
    const created = await provider.createJob({ recording, language: 'es' });
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const cancelled = await provider.cancelJob(created.providerJobId);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal((await waitForTerminal(provider, created.providerJobId)).status, 'CANCELLED');
    assert.equal(calls, 1);
  });
});

test('cancellation is real at every stage and completion can never overwrite it', async (t) => {
  for (const targetStage of ['VALIDATING', 'FETCHING_RECORDING', 'SUBMITTING', 'PROCESSING', 'FINALIZING']) {
    await t.test(targetStage, async () => {
      let provider;
      provider = providerWith(async () => jsonResponse(deepgramPayload()), {
        stageHook: async (stage, job) => {
          if (stage === targetStage) await provider.cancelJob(job.id);
        },
      });
      const created = await provider.createJob({ recording, language: 'es' });
      const state = await waitForTerminal(provider, created.providerJobId);
      assert.equal(state.status, 'CANCELLED');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await provider.getJobStatus(created.providerJobId)).status, 'CANCELLED');
      await assert.rejects(() => provider.getTranscript(created.providerJobId), { code: 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE' });
    });
  }
});

test('redirects, untrusted targets and missing configuration fail closed', async (t) => {
  await t.test('redirect response', async () => {
    const provider = providerWith(async () => new Response('', { status: 302, headers: { Location: 'https://example.com' } }));
    const created = await provider.createJob({ recording, language: 'es' });
    const state = await waitForTerminal(provider, created.providerJobId);
    assert.equal(state.errorCode, 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
  });
  const invalidCases = [
    { apiUrl: 'http://api.deepgram.com/v1/listen' },
    { apiUrl: 'https://example.com/v1/listen' },
    { apiUrl: 'https://api.deepgram.com/v1/other' },
    { apiUrl: 'https://127.0.0.1/v1/listen' },
    { apiKey: '' },
    { allowedHosts: new Set() },
  ];
  for (const overrides of invalidCases) {
    const provider = providerWith(async () => jsonResponse(deepgramPayload()), overrides);
    assert.equal(provider.isConfigured(), false, JSON.stringify([...Object.entries(overrides)].map(([key]) => key)));
    await assert.rejects(() => provider.createJob({ recording, language: 'es' }), { code: 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED' });
  }
});

test('recording readiness, duration and size are validated before any provider call', async () => {
  let calls = 0;
  const provider = providerWith(async () => { calls += 1; return jsonResponse(deepgramPayload()); }, { maxAudioBytes: 1_000, maxDurationSeconds: 30 });
  await assert.rejects(() => provider.createJob({ recording: null }), { code: 'TRANSCRIPTION_RECORDING_NOT_FOUND' });
  await assert.rejects(() => provider.createJob({ recording: { ...recording, status: 'PROCESSING' } }), { code: 'TRANSCRIPTION_RECORDING_NOT_READY' });
  await assert.rejects(() => provider.createJob({ recording: { ...recording, size: 1_001 } }), { code: 'TRANSCRIPTION_RECORDING_TOO_LARGE' });
  await assert.rejects(() => provider.createJob({ recording: { ...recording, size: 999, durationSeconds: 61 } }), { code: 'TRANSCRIPTION_RECORDING_TOO_LONG' });
  assert.equal(calls, 0);
});

test('health is configuration-only until a real job succeeds and never performs a paid probe', async () => {
  let calls = 0;
  const provider = providerWith(async () => { calls += 1; return jsonResponse(deepgramPayload()); });
  const initialHealth = await provider.healthStatus();
  assert.equal(initialHealth.configured, true);
  assert.equal(initialHealth.available, false);
  assert.equal(initialHealth.status, 'degraded');
  assert.equal(initialHealth.mode, 'deepgram');
  assert.equal(initialHealth.check, 'not-probed');
  assert.equal(calls, 0);
  const created = await provider.createJob({ recording, language: 'es' });
  await waitForTerminal(provider, created.providerJobId);
  const health = await provider.healthStatus();
  assert.equal(health.available, true);
  assert.equal(health.status, 'healthy');
  assert.equal(health.check, 'real-transcription');
  assert.equal(calls, 1);
});
