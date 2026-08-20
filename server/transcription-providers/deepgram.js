const crypto = require('node:crypto');
const { AppError } = require('../http-utils');
const { assertPublicProviderTarget, isPrivateAddress, validateProviderUrl } = require('../transcription-network');

const DEEPGRAM_HOSTNAME = 'api.deepgram.com';
const DEEPGRAM_PATHNAME = '/v1/listen';
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TERMINAL_JOB_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanProviderText(value, max = 20_000) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function speakerNumber(value) {
  if (Number.isInteger(Number(value)) && Number(value) >= 0) return Number(value);
  const match = String(value || '').match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function speakerIdentity(value, fallback = 0) {
  const number = speakerNumber(value);
  const index = number === null ? fallback : number;
  return { speakerId: `speaker-${index}`, speakerLabel: `Hablante ${index + 1}` };
}

function normalizeWord(word, fallbackSpeaker = 0) {
  const spoken = cleanProviderText(word?.word, 500);
  const punctuated = cleanProviderText(word?.punctuated_word || spoken, 500);
  if (!spoken && !punctuated) return null;
  const speaker = speakerIdentity(word?.speaker, fallbackSpeaker);
  const start = Math.max(0, finiteNumber(word?.start));
  const end = Math.max(start, finiteNumber(word?.end, start));
  return {
    word: spoken || punctuated,
    punctuatedWord: punctuated || spoken,
    start,
    end,
    confidence: Math.max(0, Math.min(1, finiteNumber(word?.confidence))),
    speakerId: speaker.speakerId,
  };
}

function averageConfidence(words, fallback = null) {
  const values = words.map((word) => Number(word.confidence)).filter(Number.isFinite);
  if (!values.length) return Number.isFinite(Number(fallback)) ? Math.max(0, Math.min(1, Number(fallback))) : null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function wordsForRange(words, start, end) {
  return words.filter((word) => word.end >= start && word.start <= end);
}

function dominantSpeaker(words, fallback = 0) {
  const counts = new Map();
  for (const word of words) counts.set(word.speakerId, (counts.get(word.speakerId) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || `speaker-${fallback}`;
}

function segmentFrom({ id, start, end, text, confidence, speaker, words = [] }, fallbackSpeaker = 0) {
  const inferredSpeaker = speaker ?? dominantSpeaker(words, fallbackSpeaker);
  const identity = speakerIdentity(inferredSpeaker, fallbackSpeaker);
  const safeStart = Math.max(0, finiteNumber(start));
  const safeEnd = Math.max(safeStart, finiteNumber(end, safeStart));
  return {
    id,
    speakerId: identity.speakerId,
    speakerLabel: identity.speakerLabel,
    participantIdentity: null,
    participantName: null,
    start: safeStart,
    end: safeEnd,
    confidence: averageConfidence(words, confidence),
    text: cleanProviderText(text),
    words,
  };
}

function groupWordsIntoSegments(words) {
  const groups = [];
  for (const word of words) {
    const previous = groups.at(-1);
    if (!previous || previous.speakerId !== word.speakerId || word.start - previous.end > 1.5) {
      groups.push({ speakerId: word.speakerId, start: word.start, end: word.end, words: [word] });
    } else {
      previous.end = Math.max(previous.end, word.end);
      previous.words.push(word);
    }
  }
  return groups.map((group, index) => segmentFrom({
    id: `deepgram-segment-${index + 1}`,
    start: group.start,
    end: group.end,
    speaker: group.speakerId,
    words: group.words,
    text: group.words.map((word) => word.punctuatedWord || word.word).join(' '),
  }, index));
}

function deepgramModel(metadata = {}) {
  if (typeof metadata.model === 'string') return cleanProviderText(metadata.model, 120);
  if (Array.isArray(metadata.models) && metadata.models.length) return cleanProviderText(metadata.models[0], 120);
  const modelInfo = metadata.model_info && typeof metadata.model_info === 'object' ? Object.values(metadata.model_info)[0] : null;
  return cleanProviderText(modelInfo?.name || modelInfo?.version || '', 120) || null;
}

function normalizeDeepgramResponse(payload, { language = 'es' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(502, 'La respuesta del proveedor no pudo validarse.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative || typeof alternative !== 'object') {
    throw new AppError(502, 'La respuesta del proveedor no pudo validarse.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
  const utterances = Array.isArray(payload.results?.utterances) ? payload.results.utterances : [];
  const rawWords = Array.isArray(alternative.words)
    ? alternative.words
    : utterances.flatMap((utterance) => Array.isArray(utterance?.words) ? utterance.words : []);
  const words = rawWords.map((word) => normalizeWord(word)).filter(Boolean);
  let segments = [];

  if (utterances.length) {
    segments = utterances.map((utterance, index) => {
      const utteranceWords = (Array.isArray(utterance.words) ? utterance.words.map((word) => normalizeWord(word, index)).filter(Boolean) : wordsForRange(words, finiteNumber(utterance.start), finiteNumber(utterance.end)));
      return segmentFrom({
        id: cleanProviderText(utterance.id, 160) || `deepgram-utterance-${index + 1}`,
        start: utterance.start,
        end: utterance.end,
        text: utterance.transcript,
        confidence: utterance.confidence,
        speaker: utterance.speaker,
        words: utteranceWords,
      }, index);
    });
  } else {
    const paragraphs = Array.isArray(alternative.paragraphs?.paragraphs) ? alternative.paragraphs.paragraphs : [];
    const sentences = paragraphs.flatMap((paragraph) => Array.isArray(paragraph?.sentences)
      ? paragraph.sentences.map((sentence) => ({ ...sentence, speaker: sentence.speaker ?? paragraph.speaker }))
      : []);
    if (sentences.length) {
      segments = sentences.map((sentence, index) => {
        const sentenceWords = wordsForRange(words, finiteNumber(sentence.start), finiteNumber(sentence.end));
        return segmentFrom({
          id: `deepgram-sentence-${index + 1}`,
          start: sentence.start,
          end: sentence.end,
          text: sentence.text,
          speaker: sentence.speaker ?? dominantSpeaker(sentenceWords, index),
          words: sentenceWords,
        }, index);
      });
    } else if (words.length) {
      segments = groupWordsIntoSegments(words);
    }
  }

  const transcriptText = cleanProviderText(alternative.transcript, 2_000_000);
  if (!segments.length && transcriptText) {
    segments = [segmentFrom({
      id: 'deepgram-segment-1',
      start: 0,
      end: payload.metadata?.duration || 0,
      text: transcriptText,
      confidence: alternative.confidence,
      speaker: 0,
      words,
    })];
  }
  segments = segments.filter((segment) => segment.text).sort((a, b) => a.start - b.start || a.end - b.end);
  if (!segments.length) {
    throw new AppError(502, 'Deepgram termin\u00f3 sin devolver texto utilizable.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }

  const metadata = payload.metadata || {};
  const providerRequestId = cleanProviderText(metadata.request_id, 160) || null;
  const durationSeconds = Math.max(0, finiteNumber(metadata.duration, segments.at(-1)?.end || 0));
  const confidence = averageConfidence(words, alternative.confidence);
  return {
    provider: 'deepgram',
    providerRequestId,
    language: cleanProviderText(metadata.language, 20) || language,
    durationSeconds,
    confidence,
    text: transcriptText || segments.map((segment) => segment.text).join(' '),
    segments,
    words,
    rawMetadata: {
      requestId: providerRequestId,
      model: deepgramModel(metadata),
      createdAt: cleanProviderText(metadata.created, 80) || null,
    },
  };
}

function retryAfterMs(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - now)) : null;
}

function httpError(status) {
  if (status === 401 || status === 403) return new AppError(502, 'No fue posible autenticar el servicio de transcripci\u00f3n.', 'TRANSCRIPTION_DEEPGRAM_AUTH_FAILED');
  if (status === 429) return new AppError(503, 'Deepgram alcanz\u00f3 temporalmente el l\u00edmite de solicitudes. Intenta nuevamente en unos minutos.', 'TRANSCRIPTION_DEEPGRAM_RATE_LIMITED');
  if (status === 413) return new AppError(413, 'La grabaci\u00f3n supera el tama\u00f1o permitido para transcripci\u00f3n.', 'TRANSCRIPTION_RECORDING_TOO_LARGE');
  if (status === 415) return new AppError(415, 'El formato de la grabaci\u00f3n no es compatible.', 'TRANSCRIPTION_AUDIO_UNSUPPORTED');
  if ([400, 404, 422].includes(status)) return new AppError(502, 'Deepgram no pudo procesar la grabaci\u00f3n enviada.', 'TRANSCRIPTION_DEEPGRAM_BAD_REQUEST');
  return new AppError(502, 'El servicio de transcripci\u00f3n no est\u00e1 disponible temporalmente.', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
}

async function readJsonResponse(response, maxBytes, job) {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new AppError(502, 'La respuesta del proveedor no pudo validarse.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(502, 'La respuesta del proveedor supera el tama\u00f1o permitido.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    try {
      while (true) {
        if (job.cancelled) {
          await reader.cancel().catch(() => {});
          throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
        }
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AppError(502, 'La respuesta del proveedor supera el tama\u00f1o permitido.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else if (typeof response.text === 'function') {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new AppError(502, 'La respuesta del proveedor supera el tama\u00f1o permitido.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  } else {
    throw new AppError(502, 'La respuesta del proveedor no pudo validarse.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(502, 'La respuesta del proveedor no pudo validarse.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  }
}

class DeepgramTranscriptionProvider {
  constructor({
    enabled = false,
    apiUrl = '',
    apiKey = '',
    allowedHosts = new Set(),
    productionLike = true,
    model = 'nova-3',
    diarize = true,
    smartFormat = true,
    utterances = true,
    paragraphs = true,
    timeoutMs = 600_000,
    maxAudioBytes = 2 * 1024 * 1024 * 1024,
    maxDurationSeconds = 240 * 60,
    retryMax = 2,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = global.fetch,
    lookupImpl,
    sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    stageHook = null,
  } = {}) {
    this.enabled = enabled;
    this.providerName = 'deepgram';
    this.apiUrl = String(apiUrl || '').trim();
    this.apiKey = String(apiKey || '');
    this.allowedHosts = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts || []);
    this.productionLike = productionLike;
    this.model = cleanProviderText(model, 80) || 'nova-3';
    this.diarize = diarize === true;
    this.smartFormat = smartFormat === true;
    this.utterances = utterances === true;
    this.paragraphs = paragraphs === true;
    this.timeoutMs = Math.max(10, Number(timeoutMs) || 600_000);
    this.maxAudioBytes = Math.max(1, Number(maxAudioBytes) || 2 * 1024 * 1024 * 1024);
    this.maxDurationSeconds = Math.max(60, Number(maxDurationSeconds) || 240 * 60);
    this.retryMax = Math.max(0, Math.min(5, Number(retryMax) || 0));
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES);
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.sleepImpl = sleepImpl;
    this.stageHook = stageHook;
    this.jobs = new Map();
    this.lastHealth = null;
  }

  isConfigured() {
    return Boolean(this.enabled && this.apiKey && typeof this.fetchImpl === 'function' && validateProviderUrl(this.apiUrl, {
      allowedHosts: this.allowedHosts,
      exactHostname: DEEPGRAM_HOSTNAME,
      exactPathname: DEEPGRAM_PATHNAME,
      productionLike: this.productionLike,
    }));
  }

  async healthStatus() {
    const checkedAt = new Date().toISOString();
    if (!this.enabled) return { configured: false, available: false, status: 'disabled', mode: 'deepgram', checkedAt };
    if (!this.isConfigured()) return { configured: false, available: false, status: 'degraded', mode: 'deepgram', checkedAt };
    if (this.lastHealth) return { configured: true, mode: 'deepgram', checkedAt, ...this.lastHealth };
    return { configured: true, available: false, status: 'degraded', mode: 'deepgram', check: 'not-probed', checkedAt };
  }

  validateRecording(recording) {
    if (!recording?.id) throw new AppError(404, 'La grabaci\u00f3n no existe.', 'TRANSCRIPTION_RECORDING_NOT_FOUND');
    if (recording.status !== 'READY' || !recording.available || !recording.url) throw new AppError(409, 'La grabaci\u00f3n a\u00fan no est\u00e1 lista para transcribirse.', 'TRANSCRIPTION_RECORDING_NOT_READY');
    if (Number(recording.size || 0) > this.maxAudioBytes) throw new AppError(413, 'La grabaci\u00f3n supera el tama\u00f1o permitido para transcripci\u00f3n.', 'TRANSCRIPTION_RECORDING_TOO_LARGE');
    if (Number(recording.durationSeconds || 0) > this.maxDurationSeconds) throw new AppError(413, 'La grabaci\u00f3n supera la duraci\u00f3n m\u00e1xima permitida.', 'TRANSCRIPTION_RECORDING_TOO_LONG');
    let audioUrl;
    try { audioUrl = new URL(recording.url); } catch {}
    if (!audioUrl || audioUrl.protocol !== 'https:' || audioUrl.username || audioUrl.password || isPrivateAddress(audioUrl.hostname) || audioUrl.hostname.endsWith('.local')) {
      throw new AppError(409, 'La grabaci\u00f3n no tiene un origen de audio seguro.', 'TRANSCRIPTION_RECORDING_NOT_READY');
    }
  }

  buildRequestUrl(language) {
    const requestUrl = new URL(this.apiUrl);
    requestUrl.searchParams.set('model', this.model);
    requestUrl.searchParams.set('language', cleanProviderText(language, 20) || 'es');
    requestUrl.searchParams.set('punctuate', 'true');
    requestUrl.searchParams.set('smart_format', String(this.smartFormat));
    requestUrl.searchParams.set('utterances', String(this.utterances));
    requestUrl.searchParams.set('paragraphs', String(this.paragraphs));
    if (this.diarize) requestUrl.searchParams.set('diarize_model', 'latest');
    return requestUrl.href;
  }

  pruneJobs() {
    if (this.jobs.size < 500) return;
    for (const [id, job] of this.jobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) this.jobs.delete(id);
      if (this.jobs.size < 400) break;
    }
  }

  async createJob({ recording, language = 'es' }) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripci\u00f3n no est\u00e1 configurado.', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
    this.validateRecording(recording);
    this.pruneJobs();
    const providerJobId = `deepgram-${crypto.randomUUID()}`;
    const job = {
      id: providerJobId,
      status: 'PENDING',
      progress: 0,
      cancelled: false,
      controller: null,
      result: null,
      errorCode: null,
      errorMessageSafe: null,
      createdAt: Date.now(),
      startTimer: null,
    };
    this.jobs.set(providerJobId, job);
    job.startTimer = setTimeout(() => {
      job.startTimer = null;
      this.runJob(job, { recording, language }).catch((error) => this.failJob(job, error));
    }, 0);
    return { providerJobId, status: job.status, progress: job.progress };
  }

  async setStage(job, status, progress) {
    if (job.cancelled) return false;
    job.status = status;
    job.progress = progress;
    if (status === 'SUBMITTING' && !job.submittedAt) job.submittedAt = new Date().toISOString();
    if (typeof this.stageHook === 'function') await this.stageHook(status, job);
    return !job.cancelled;
  }

  async runJob(job, { recording, language }) {
    if (!await this.setStage(job, 'VALIDATING', 10)) return;
    this.validateRecording(recording);
    if (!await this.setStage(job, 'FETCHING_RECORDING', 25)) return;
    if (!await this.setStage(job, 'SUBMITTING', 45)) return;
    await assertPublicProviderTarget(this.apiUrl, { lookupImpl: this.lookupImpl, productionLike: this.productionLike });
    const responsePayload = await this.requestDeepgram(job, { audioUrl: recording.url, language });
    if (job.cancelled) return;
    if (typeof this.stageHook === 'function') await this.stageHook('FINALIZING', job);
    if (job.cancelled) return;
    const result = normalizeDeepgramResponse(responsePayload, { language });
    if (job.cancelled) return;
    job.result = result;
    job.status = 'COMPLETED';
    job.progress = 100;
    job.providerRequestId = result.providerRequestId;
    this.lastHealth = { available: true, status: 'healthy', check: 'real-transcription', lastSuccessAt: new Date().toISOString() };
  }

  async requestDeepgram(job, { audioUrl, language }) {
    const requestUrl = this.buildRequestUrl(language);
    for (let attempt = 0; attempt <= this.retryMax; attempt += 1) {
      if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
      const controller = new AbortController();
      job.controller = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      let response;
      try {
        const responsePromise = this.fetchImpl(requestUrl, {
          method: 'POST',
          headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: audioUrl }),
          redirect: 'error',
          signal: controller.signal,
        });
        if (!await this.setStage(job, 'PROCESSING', 80)) {
          controller.abort();
          throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
        }
        response = await responsePromise;
      } catch (error) {
        clearTimeout(timeout);
        job.controller = null;
        if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
        if (timedOut) throw new AppError(504, 'La transcripci\u00f3n tard\u00f3 m\u00e1s de lo permitido.', 'TRANSCRIPTION_DEEPGRAM_TIMEOUT');
        if (error instanceof AppError) throw error;
        throw new AppError(502, 'El servicio de transcripci\u00f3n no est\u00e1 disponible temporalmente.', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
      }
      if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        clearTimeout(timeout);
        job.controller = null;
        await response.body?.cancel?.().catch(() => {});
        throw new AppError(502, 'El proveedor intent\u00f3 redirigir la solicitud.', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
      }
      if (!response.ok) {
        clearTimeout(timeout);
        job.controller = null;
        const delay = response.status === 429 ? retryAfterMs(response) : null;
        await response.body?.cancel?.().catch(() => {});
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.retryMax) {
          await this.waitBeforeRetry(job, delay ?? Math.min(4_000, 500 * (2 ** attempt)));
          continue;
        }
        throw httpError(response.status);
      }
      try {
        return await readJsonResponse(response, this.maxResponseBytes, job);
      } catch (error) {
        if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
        if (timedOut) throw new AppError(504, 'La transcripci\u00f3n tard\u00f3 m\u00e1s de lo permitido.', 'TRANSCRIPTION_DEEPGRAM_TIMEOUT');
        throw error;
      } finally {
        clearTimeout(timeout);
        if (job.controller === controller) job.controller = null;
      }
    }
    throw new AppError(502, 'El servicio de transcripci\u00f3n no est\u00e1 disponible temporalmente.', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
  }

  async waitBeforeRetry(job, delayMs) {
    if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
    const controller = new AbortController();
    job.controller = controller;
    try {
      await Promise.race([
        Promise.resolve(this.sleepImpl(delayMs, job)),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED')), { once: true })),
      ]);
    } finally {
      if (job.controller === controller) job.controller = null;
    }
    if (job.cancelled) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
  }

  failJob(job, error) {
    if (job.cancelled || error?.code === 'TRANSCRIPTION_CANCELLED') {
      job.status = 'CANCELLED';
      job.progress = 0;
      return;
    }
    job.status = 'FAILED';
    job.progress = 0;
    job.errorCode = cleanProviderText(error?.code || 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE', 100);
    job.errorMessageSafe = cleanProviderText(error?.message || 'No fue posible completar la transcripci\u00f3n.', 300);
    this.lastHealth = { available: false, status: 'degraded', check: 'real-transcription', lastFailureAt: new Date().toISOString(), errorCode: job.errorCode };
  }

  async getJobStatus(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El trabajo de transcripci\u00f3n ya no est\u00e1 disponible en este proceso. Puedes reintentarlo.', 'PROVIDER_JOB_NOT_FOUND');
    return {
      status: job.status,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessageSafe: job.errorMessageSafe,
      providerRequestId: job.providerRequestId || null,
      submittedAt: job.submittedAt || null,
    };
  }

  async cancelJob(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) throw new AppError(502, 'El trabajo de transcripci\u00f3n ya no est\u00e1 disponible en este proceso. Puedes reintentarlo.', 'PROVIDER_JOB_NOT_FOUND');
    if (job.status === 'COMPLETED') return { status: 'COMPLETED', cancelled: false };
    if (job.status === 'FAILED') return { status: 'FAILED', cancelled: false, errorCode: job.errorCode, errorMessageSafe: job.errorMessageSafe };
    job.cancelled = true;
    if (job.startTimer) clearTimeout(job.startTimer);
    job.startTimer = null;
    job.controller?.abort();
    job.status = 'CANCELLED';
    job.progress = 0;
    return { status: 'CANCELLED', cancelled: true };
  }

  async getTranscript(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job?.result || job.status !== 'COMPLETED') throw new AppError(502, 'El proveedor no devolvi\u00f3 una transcripci\u00f3n utilizable.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
    return job.result;
  }

  async transcribe({ recording, language = 'es', onStage, isCancelled } = {}) {
    if (!this.isConfigured()) throw new AppError(503, 'El proveedor de transcripci\u00f3n no est\u00e1 configurado.', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
    this.validateRecording(recording);
    const providerJobId = `deepgram-${crypto.randomUUID()}`;
    const job = {
      id: providerJobId,
      status: 'PENDING',
      progress: 0,
      cancelled: false,
      controller: null,
      result: null,
      errorCode: null,
      errorMessageSafe: null,
      createdAt: Date.now(),
    };
    const previousHook = this.stageHook;
    this.stageHook = async (status, currentJob) => {
      if (typeof isCancelled === 'function' && await isCancelled()) {
        currentJob.cancelled = true;
        currentJob.controller?.abort();
        throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
      }
      if (typeof onStage === 'function') await onStage(status, currentJob);
      if (typeof previousHook === 'function') await previousHook(status, currentJob);
    };
    try {
      await this.runJob(job, { recording, language });
    } catch (error) {
      this.failJob(job, error);
      throw error;
    } finally {
      this.stageHook = previousHook;
    }
    if (!job.result || job.status !== 'COMPLETED') throw new AppError(502, 'El proveedor no devolvi\u00f3 una transcripci\u00f3n utilizable.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
    return { ...job.result, providerJobId, providerRequestId: job.providerRequestId || job.result.providerRequestId || null, status: job.status };
  }
}

module.exports = {
  DEEPGRAM_HOSTNAME,
  DEEPGRAM_PATHNAME,
  DeepgramTranscriptionProvider,
  normalizeDeepgramResponse,
  retryAfterMs,
};
