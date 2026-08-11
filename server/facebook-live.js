const { EgressStatus, StreamProtocol } = require('livekit-server-sdk');
const { AppError } = require('./http-utils');

const MAX_SERVER_URL_LENGTH = 512;
const MAX_STREAM_KEY_LENGTH = 512;

function egressStatusName(info) {
  if (!info) return '';
  return typeof info.status === 'string' ? info.status : EgressStatus[info.status] || '';
}

function egressRequest(info) {
  return info?.request?.value || info?.request || {};
}

function isStreamingEgress(info) {
  const request = egressRequest(info);
  return Boolean(
    info?.streamResults?.length ||
    request?.streamOutputs?.length ||
    request?.output?.case === 'stream'
  );
}

function isRecordingEgress(info) {
  const request = egressRequest(info);
  return Boolean(
    info?.fileResults?.length ||
    request?.fileOutputs?.length ||
    request?.output?.case === 'file'
  );
}

function validateFacebookDestination(serverUrl, streamKey) {
  if (typeof serverUrl !== 'string' || serverUrl.length < 8 || serverUrl.length > MAX_SERVER_URL_LENGTH) {
    throw new AppError(400, 'Ingresa un servidor RTMP/RTMPS válido', 'FACEBOOK_SERVER_INVALID');
  }
  if (typeof streamKey !== 'string' || streamKey.length < 6 || streamKey.length > MAX_STREAM_KEY_LENGTH) {
    throw new AppError(400, 'Ingresa una clave de transmisión válida', 'FACEBOOK_STREAM_KEY_INVALID');
  }
  if (serverUrl !== serverUrl.trim() || streamKey !== streamKey.trim() || /[\u0000-\u001f\u007f]/.test(serverUrl + streamKey)) {
    throw new AppError(400, 'Los datos de Facebook Live no tienen un formato válido', 'FACEBOOK_DESTINATION_INVALID');
  }
  if (/[\s/?#]/.test(streamKey)) {
    throw new AppError(400, 'La clave de transmisión no tiene un formato válido', 'FACEBOOK_STREAM_KEY_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new AppError(400, 'Ingresa un servidor RTMP/RTMPS válido', 'FACEBOOK_SERVER_INVALID');
  }
  if (!['rtmp:', 'rtmps:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError(400, 'Solo se permiten servidores rtmp:// o rtmps:// sin credenciales ni parámetros', 'FACEBOOK_PROTOCOL_INVALID');
  }
  return {
    output: { protocol: StreamProtocol.RTMP, urls: [`${serverUrl.replace(/\/+$/, '')}/${streamKey}`] },
  };
}

function facebookStateFromEgress(info, metadata = {}) {
  if (!info) return { provider: 'facebook', state: 'IDLE', active: false, egressId: null, startedAt: metadata.startedAt || null, stoppedAt: metadata.stoppedAt || null };
  const status = egressStatusName(info);
  const states = {
    EGRESS_STARTING: ['SENDING', true],
    EGRESS_ACTIVE: ['ACTIVE', true],
    EGRESS_ENDING: ['STOPPING', true],
    EGRESS_COMPLETE: ['IDLE', false],
    EGRESS_FAILED: ['ERROR', false],
    EGRESS_ABORTED: ['ERROR', false],
    EGRESS_LIMIT_REACHED: ['ERROR', false],
  };
  const [state, active] = states[status] || ['ERROR', false];
  return {
    provider: 'facebook',
    state,
    active,
    egressId: info.egressId || metadata.egressId || null,
    startedAt: metadata.startedAt || null,
    stoppedAt: metadata.stoppedAt || null,
  };
}

module.exports = {
  MAX_SERVER_URL_LENGTH,
  MAX_STREAM_KEY_LENGTH,
  facebookStateFromEgress,
  isRecordingEgress,
  isStreamingEgress,
  validateFacebookDestination,
};
