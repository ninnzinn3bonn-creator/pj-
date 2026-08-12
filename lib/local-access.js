'use strict';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizedHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHostname(value) {
  return LOOPBACK_HOSTS.has(normalizedHostname(value));
}

function parseHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error(`${label}が正しくありません。`);
    error.status = 403;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    const error = new Error(`${label}はlocalhostのみ許可されています。`);
    error.status = 403;
    throw error;
  }
  return parsed;
}

function assertLocalRequest(request) {
  const host = String(request.headers.host || '').trim();
  const requestUrl = parseHttpUrl(`http://${host}`, 'Host');
  const method = String(request.method || 'GET').toUpperCase();
  const origin = request.headers.origin;

  if (MUTATING_METHODS.has(method) && origin) {
    const originUrl = parseHttpUrl(origin, 'Origin');
    if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== requestUrl.host.toLowerCase()) {
      const error = new Error('変更操作は同一のlocalhost Originからのみ許可されています。');
      error.status = 403;
      throw error;
    }
  }
}

function normalizeLoopbackUrl(value) {
  const parsed = parseHttpUrl(String(value || '').trim(), '管理サイトURL');
  if (parsed.protocol !== 'http:') throw new Error('管理サイトURLはhttp://のlocalhostに限定されています。');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

module.exports = { assertLocalRequest, isLoopbackHostname, normalizeLoopbackUrl };
