const crypto = require('crypto');
const { AppError } = require('./http-utils');
const { config } = require('./config');

class TranscriptionProvider {
  isConfigured() { return false; }
  async createJob() { throw new Error('createJob no implementado'); }
  async getJobStatus() { throw new Error('getJobStatus no implementado'); }
  async cancelJob() { throw new Error('cancelJob no implementado'); }
  async getTranscript() { throw new Error('getTranscript no implementado'); }
}

class MockTranscriptionProvider extends TranscriptionProvider {
  constructor({ configured = false, fixtures = {} } = {}) {
    super();
    this.configured = configured;
    this.fixtures = fixtures;
    this.jobs = new Map();
  }

  isConfigured() { return this.configured; }

  async createJob({ recording, language }) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripción no está configurado', 'TRANSCRIPTION_NOT_CONFIGURED');
    if (!recording?.id || (!recording.url && !recording.available)) throw new AppError(409, 'La grabación no contiene audio disponible', 'RECORDING_NOT_READY');
    const fixture = this.fixtures[recording.id] || null;
    const providerJobId = `mock-${crypto.randomUUID()}`;
    this.jobs.set(providerJobId, { fixture, language, poll: 0, cancelled: false });
    return { providerJobId, status: 'QUEUED', progress: 0 };
  }

  async getJobStatus(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El proveedor no reconoce el trabajo', 'PROVIDER_JOB_NOT_FOUND');
    if (job.cancelled) return { status: 'CANCELLED', progress: 0 };
    if (job.fixture?.failure) return { status: 'FAILED', progress: job.fixture.progress || 0, errorCode: 'MOCK_FAILURE', errorMessageSafe: 'El proveedor de prueba informó un fallo.' };
    if (!job.fixture?.segments) return { status: 'FAILED', progress: 0, errorCode: 'NO_MOCK_RESULT', errorMessageSafe: 'No existe un resultado de prueba asociado a esta grabación.' };
    const sequence = job.fixture.statuses || [
      { status: 'PROCESSING_AUDIO', progress: 25 },
      { status: 'IDENTIFYING_PARTICIPANTS', progress: 55 },
      { status: 'GENERATING_TRANSCRIPT', progress: 80 },
      { status: job.fixture.warnings?.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED', progress: 100 },
    ];
    const state = sequence[Math.min(job.poll, sequence.length - 1)];
    job.poll += 1;
    return { ...state };
  }

  async cancelJob(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El proveedor no reconoce el trabajo', 'PROVIDER_JOB_NOT_FOUND');
    job.cancelled = true;
    return { status: 'CANCELLED' };
  }

  async getTranscript(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job?.fixture?.segments) throw new AppError(502, 'El proveedor no devolvió una transcripción', 'TRANSCRIPT_RESULT_MISSING');
    return {
      language: job.fixture.language || job.language || 'es',
      durationSeconds: job.fixture.durationSeconds || 0,
      speakers: job.fixture.speakers || [],
      segments: job.fixture.segments,
      warnings: job.fixture.warnings || [],
    };
  }
}

class HttpTranscriptionProvider extends TranscriptionProvider {
  constructor({ enabled, apiUrl, apiKey, fetchImpl = global.fetch } = {}) {
    super();
    this.enabled = enabled;
    this.apiUrl = String(apiUrl || '').replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    if (!this.enabled || !this.apiUrl || !this.apiKey || typeof this.fetchImpl !== 'function') return false;
    try {
      const parsed = new URL(this.apiUrl);
      return parsed.protocol === 'https:' || (!config.isProduction && parsed.hostname === 'localhost');
    } catch {
      return false;
    }
  }

  async request(pathname, options = {}) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripción no está configurado', 'TRANSCRIPTION_NOT_CONFIGURED');
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${pathname}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, 'No fue posible comunicarse con el proveedor de transcripción', 'TRANSCRIPTION_PROVIDER_UNAVAILABLE');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(502, 'El proveedor de transcripción rechazó la solicitud', 'TRANSCRIPTION_PROVIDER_ERROR');
    return data;
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
  if (config.transcriptionProvider === 'http') {
    return new HttpTranscriptionProvider({
      enabled: config.transcriptionEnabled,
      apiUrl: config.transcriptionApiUrl,
      apiKey: process.env.TRANSCRIPTION_API_KEY,
    });
  }
  if (config.transcriptionProvider === 'mock') return new MockTranscriptionProvider({ configured: config.transcriptionEnabled });
  return new MockTranscriptionProvider({ configured: false });
}

module.exports = {
  HttpTranscriptionProvider,
  MockTranscriptionProvider,
  TranscriptionProvider,
  createTranscriptionProvider,
};
