/*
 * USBos — system/crypto.js
 * Primitives de chiffrement du noyau : dérivation de clé (PBKDF2) et
 * chiffrement authentifié (AES-GCM). Utilisé pour chiffrer TOUTES les
 * données d'apps par défaut (pas seulement le Coffre), via une passphrase
 * de session saisie une fois au déverrouillage.
 */
'use strict';

// NOTE compat : 210000 itérations historiques. Un bump (ex. 600k, reco OWASP)
// changerait TOUTES les clés dérivées et verrouillerait les clés chiffrées
// existantes hors de leurs données. Ne monter qu'avec une enveloppe KDF
// versionnée + migration de ré-encryption (non implémentée v1).
const PBKDF2_ITERATIONS = 210000;
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

function generateSalt(len = 16) {
  return crypto.getRandomValues(new Uint8Array(len));
}

function normalizeAad(aad) {
  if (aad === undefined || aad === null) return undefined;
  if (typeof aad === 'string') return new TextEncoder().encode(aad);
  if (aad instanceof Uint8Array) return aad;
  if (ArrayBuffer.isView(aad)) return new Uint8Array(aad.buffer, aad.byteOffset, aad.byteLength);
  if (aad instanceof ArrayBuffer) return new Uint8Array(aad);
  throw new TypeError('AAD invalide (string|Uint8Array attendu).');
}

async function deriveMasterKey(passphrase, saltBytes) {
  // NOTE : pas de normalize('NFKC') ici — toute normalisation modifierait les
  // clés dérivées et verrouillerait les passphrases non-ASCII existantes.
  const raw = String(passphrase);
  if (raw.length > 512) throw new Error('Passphrase trop longue (max 512 caractères).');
  if (!raw || raw.length < 8) throw new Error('Passphrase trop courte (min 8 caractères).');
  const salt = saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes);
  if (salt.length < 16) throw new Error('Sel trop court (min 16 octets).');
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(raw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Format v2 : MAGIC 'U1' (0x55 0x31) + ver 0x01 + IV 12 octets + ciphertext AES-GCM.
// Lecture compatible v1 legacy (IV 12 || ct sans magic).
async function encryptBuffer(key, arrayBuffer, aad) {
  if (!key) throw new Error('Clé manquante.');
  let data;
  if (arrayBuffer instanceof ArrayBuffer) data = arrayBuffer;
  else if (ArrayBuffer.isView(arrayBuffer)) data = arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
  else throw new TypeError('Données à chiffrer invalides (ArrayBuffer ou vue typée attendu).');
  if (data.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Données trop volumineuses (max 64 Mo).');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = normalizeAad(aad);
  const params = additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv };
  const cipher = await crypto.subtle.encrypt(params, key, data);
  const out = new Uint8Array(3 + iv.length + cipher.byteLength);
  out[0] = 0x55; out[1] = 0x31; out[2] = 0x01;
  out.set(iv, 3); out.set(new Uint8Array(cipher), 3 + iv.length);
  return out.buffer;
}

async function decryptBuffer(key, buffer, aad) {
  if (!key) throw new Error('Clé manquante.');
  const bytes = buffer instanceof Uint8Array ? buffer : buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  const additionalData = normalizeAad(aad);
  try {
    if (bytes.length >= 3 && bytes[0] === 0x55 && bytes[1] === 0x31 && bytes[2] === 0x01) {
      if (bytes.length < 3 + 12 + 16) throw new Error('Données chiffrées tronquées.');
      const iv = bytes.slice(3, 15);
      const cipher = bytes.slice(15);
      const params = additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv };
      return await crypto.subtle.decrypt(params, key, cipher);
    }
    if (bytes.length < 28) throw new Error('Données chiffrées tronquées.');
    const iv = bytes.slice(0, 12);
    const cipher = bytes.slice(12);
    const params = additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv };
    return await crypto.subtle.decrypt(params, key, cipher);
  } catch (err) {
    if (err && err.name === 'OperationError') throw new Error('Déchiffrement impossible (passphrase incorrecte ou données corrompues).');
    throw err;
  }
}

window.USBosCrypto = { deriveMasterKey, encryptBuffer, decryptBuffer, generateSalt, PBKDF2_ITERATIONS };
