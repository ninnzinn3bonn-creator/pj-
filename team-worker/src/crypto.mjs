const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRETは32文字以上で設定してください。');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(JSON.stringify(value)));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function unseal(value, secret) {
  const [ivText, payloadText] = String(value || '').split('.');
  if (!ivText || !payloadText) throw new Error('セッションが正しくありません。');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(ivText) },
    await encryptionKey(secret),
    base64UrlToBytes(payloadText)
  );
  const payload = JSON.parse(decoder.decode(decrypted));
  if (!payload.expiresAt || Date.now() >= payload.expiresAt) throw new Error('セッションの有効期限が切れています。');
  return payload;
}

export async function revisionFor(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
