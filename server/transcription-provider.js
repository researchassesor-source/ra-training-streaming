const crypto = require('node:crypto');
const { AppError } = require('./http-utils');
const { config } = require('./config');
const { assertPublicProviderTarget, isPrivateAddress, validateProviderUrl } = require('./transcription-network');

class TranscriptionProvider {
  isConfigured() { return false; }
  async healthStatus() { return { configured: false, available: false, status: 'disabled', checkedAt: new Date().toISOString() }; }
  async createJob() { throw new Error('createJob no implementado'); }
  async getJobStatus() { throw new Error('getJobStatus no implementado'); }
  async cancelJob() { throw new Error('cancelJob no implementado'); }
  async getTranscript() { throw new Error('getTranscript no implementado'); }
}

class UnsupportedTranscriptionProvider extends TranscriptionProvider {
  constructor(providerName) {
    super();
    this.providerName = String(providerName || 'unknown').slice(0, 60);
    this.unsupported = true;
  }

  async healthStatus() {
    return { configured: false, available: false, status: 'disabled', mode: 'unsupported', errorCode: 'TRANSCRIPTION_PROVIDER_UNSUPPORTED', checkedAt: new Date().toISOString() };
  }
}

class MockTranscriptionProvider extends TranscriptionProvider {
  constructor({ configured = false, fixtures = {} } = {}) {
    super();
    this.configured = configured;
    this.fixtures = fixtures;
    this.jobs = new Map();
  }

  isConfigured() { return this.configured; }

  async healthStatus() {
    return {
      configured: this.isConfigured(),
      available: this.isConfigured(),
      status: this.isConfigured() ? 'healthy' : 'disabled',
      mode: 'mock',
      checkedAt: new Date().toISOString(),
    };
  }

  async createJob({ recording, language }) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripci\u00f3n no est\u00e1 configurado', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
    if (!recording?.id || (!recording.url && !recording.available)) throw new AppError(409, 'La grabaci\u00f3n no contiene audio disponible', 'TRANSCRIPTION_RECORDING_NOT_READY');
    const fixture = this.fixtures[recording.id] || null;
    const providerJobId = `mock-${crypto.randomUUID()}`;
    this.jobs.set(providerJobId, { fixture, language, poll: 0, cancelled: false });
    return { providerJobId, status: 'PENDING', progress: 0 };
  }

  async getJobStatus(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El proveedor no reconoce el trabajo', 'PROVIDER_JOB_NOT_FOUND');
    if (job.cancelled) return { status: 'CANCELLED', progress: 0 };
    if (job.fixture?.failure) return { status: 'FAILED', progress: job.fixture.progress || 0, errorCode: 'MOCK_FAILURE', errorMessageSafe: 'El proveedor de prueba inform\u00f3 un fallo.' };
    if (!job.fixture?.segments) return { status: 'FAILED', progress: 0, errorCode: 'NO_MOCK_RESULT', errorMessageSafe: 'No existe un resultado de prueba asociado a esta grabaci\u00f3n.' };
    const sequence = job.fixture.statuses || [
      { status: 'VALIDATING', progress: 10 },
      { status: 'FETCHING_RECORDING', progress: 25 },
      { status: 'PROCESSING', progress: 80 },
      { status: job.fixture.warnings?.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED', progress: 100 },
    ];
    const state = sequence[Math.min(job.poll, sequence.length - 1)];
    job.poll += 1;
    return { ...state };
  }

  async cancelJob(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El proveedor no reconoce el trabajo', 'PROVIDER_JOB_NOT_FOUND');
    if (job.fixture?.completeBeforeCancel) return { status: 'COMPLETED', cancelled: false };
    job.cancelled = true;
    return { status: 'CANCELLED', cancelled: true };
  }

  async getTranscript(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job?.fixture?.segments) throw new AppError(502, 'El proveedor no devolvi\u00f3 una transcripci\u00f3n', 'TRANSCRIPT_RESULT_MISSING');
    return {
      provider: 'mock',
      language: job.fixture.language || job.language || 'es',
      durationSeconds: job.fixture.durationSeconds || 0,
      confidence: job.fixture.confidence ?? null,
      speakers: job.fixture.speakers || [],
      segments: job.fixture.segments,
      words: job.fixture.words || [],
      warnings: job.fixture.warnings || [],
      rawMetadata: job.fixture.rawMetadata || {},
    };
  }
}

class HttpTranscriptionProvider extends TranscriptionProvider {
  constructor({ enabled, apiUrl, apiKey, fetchImpl = global.fetch, lookupImpl } = {}) {
    super();
    this.enabled = enabled;
    this.apiUrl = String(apiUrl || '').replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.healthCache = null;
    this.healthCacheAt = 0;
  }

  isConfigured() {
    if (!this.enabled || !this.apiUrl || !this.apiKey || typeof this.fetchImpl !== 'function') return false;
    return Boolean(validateProviderUrl(this.apiUrl, {
      allowedHosts: config.transcriptionAllowedHosts,
      productionLike: config.isProductionLike,
      allowLocalDevelopment: true,
    }));
  }

  async assertPublicTarget() {
    return assertPublicProviderTarget(this.apiUrl, { lookupImpl: this.lookupImpl, productionLike: config.isProductionLike });
  }

  async request(pathname, options = {}) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripci\u00f3n no est\u00e1 configurado', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
    await this.assertPublicTarget();
    let response;
    try {
      const { timeoutMs = 20_000, ...fetchOptions } = options;
      response = await this.fetchImpl(`${this.apiUrl}${pathname}`, {
        ...fetchOptions,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError(502, 'No fue posible comunicarse con el proveedor de transcripci\u00f3n', 'TRANSCRIPTION_PROVIDER_UNAVAILABLE');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(502, 'El proveedor de transcripci\u00f3n rechaz\u00f3 la solicitud', 'TRANSCRIPTION_PROVIDER_ERROR');
    return data;
  }

  async healthStatus({ fresh = false } = {}) {
    const configured = this.isConfigured();
    if (!configured) return { configured: false, available: false, status: this.enabled ? 'degraded' : 'disabled', mode: 'http', checkedAt: new Date().toISOString() };
    if (!fresh && this.healthCache && Date.now() - this.healthCacheAt < 30_000) return this.healthCache;
    try {
      await this.request('/health', { method: 'GET', timeoutMs: 3_000 });
      this.healthCache = { configured: true, available: true, status: 'healthy', mode: 'http', checkedAt: new Date().toISOString() };
    } catch (error) {
      this.healthCache = { configured: true, available: false, status: 'degraded', mode: 'http', checkedAt: new Date().toISOString(), errorCode: String(error.code || 'TRANSCRIPTION_PROVIDER_UNAVAILABLE').slice(0, 80) };
    }
    this.healthCacheAt = Date.now();
    return this.healthCache;
  }

  createJob({ recording, meeting, language, callbackUrl }) {
    return this.request('/jobs', { method: 'POST', body: JSON.stringify({
      recordingUrl: recording.url,
      recordingId: recording.id,
      meetingId: meeting.id,
      language,
      callbackUrl,
      tracks: Array.isArray(recording.tracks) ? recording.tracks : [],
    }) });
  }

  getJobStatus(providerJobId) { return this.request(`/jobs/${encodeURIComponent(providerJobId)}`); }
  cancelJob(providerJobId) { return this.request(`/jobs/${encodeURIComponent(providerJobId)}/cancel`, { method: 'POST' }); }
  getTranscript(providerJobId) { return this.request(`/jobs/${encodeURIComponent(providerJobId)}/transcript`); }
}

function createTranscriptionProvider() {
  if (config.transcriptionProvider === 'deepgram') {
    const { DeepgramTranscriptionProvider } = require('./transcription-providers/deepgram');
    return new DeepgramTranscriptionProvider({
      enabled: config.transcriptionEnabled,
      apiUrl: config.transcriptionApiUrl,
      apiKey: process.env.TRANSCRIPTION_API_KEY,
      allowedHosts: config.transcriptionAllowedHosts,
      productionLike: config.isProductionLike,
      model: config.transcriptionDeepgramModel,
      diarize: config.transcriptionDeepgramDiarize,
      smartFormat: config.transcriptionDeepgramSmartFormat,
      utterances: config.transcriptionDeepgramUtterances,
      paragraphs: config.transcriptionDeepgramParagraphs,
      timeoutMs: config.transcriptionRequestTimeoutMs,
      maxAudioBytes: config.transcriptionMaxAudioBytes,
      maxDurationSeconds: config.transcriptionMaxDurationMinutes * 60,
      retryMax: config.transcriptionRetryMax,
    });
  }
  if (config.transcriptionProvider === 'http') {
    return new HttpTranscriptionProvider({
      enabled: config.transcriptionEnabled,
      apiUrl: config.transcriptionApiUrl,
      apiKey: process.env.TRANSCRIPTION_API_KEY,
    });
  }
  if (config.transcriptionProvider === 'mock') return new MockTranscriptionProvider({ configured: config.transcriptionEnabled });
  return new UnsupportedTranscriptionProvider(config.transcriptionProvider);
}

module.exports = {
  HttpTranscriptionProvider,
  MockTranscriptionProvider,
  TranscriptionProvider,
  UnsupportedTranscriptionProvider,
  createTranscriptionProvider,
  isPrivateAddress,
};
