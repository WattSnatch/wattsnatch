/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// At-rest encryption for secrets that never leave this machine: OAuth tokens,
// API keys, calendar credentials. For backups, which are meant to leave the
// machine, see src/utils/backupCrypto.js (passphrase-derived, deliberately
// separate).
//
// The key is random, generated once, and stored in the database - the same
// approach already used for session_secret. It used to be derived from the
// Mac's hardware UUID via `system_profiler`, with a hardcoded string as the
// fallback when that command was unavailable. That meant every install on
// Linux or Windows - which is every headless server - encrypted its secrets
// with a constant that is committed to a public repository, so the encryption
// provided no protection at all on those platforms.
//
// Legacy keys are still tried on decrypt so existing installs keep working, and
// migrateLegacySecrets() re-encrypts anything found under a legacy key.

const crypto = require('crypto');
const { execSync } = require('child_process');
const db = require('../db');

const ALGORITHM = 'aes-256-gcm';
const KEY_SETTING = 'encryption_key';

// The hardcoded fallback from the previous scheme. Retained ONLY so data
// written under it can still be read and migrated. Never used to encrypt.
const LEGACY_FALLBACK_SECRET = 'solarcharge-dev-key-do-not-use-in-production-env';

let _key = null;
let _legacyKeys = null;

/**
 * The current encryption key: random, 32 bytes, persisted on first use.
 *
 * Requires the database to be initialised. Every caller reaches this well
 * after initDb() runs in server.js, and scripts call db.initDb() themselves.
 */
function getKey() {
  if (_key) return _key;

  const existing = db.getSetting(KEY_SETTING);
  if (existing) {
    _key = Buffer.from(existing, 'hex');
    // A truncated or corrupted value would otherwise fail deep inside
    // createCipheriv with something unhelpful.
    if (_key.length !== 32) {
      throw new Error(
        `${KEY_SETTING} is ${_key.length} bytes, expected 32. Refusing to encrypt with a malformed key.`
      );
    }
    return _key;
  }

  _key = crypto.randomBytes(32);
  db.setSetting(KEY_SETTING, _key.toString('hex'));
  return _key;
}

/**
 * Keys from the previous derivation scheme, newest first. Used only to read
 * data written before the key moved into the database.
 */
function getLegacyKeys() {
  if (_legacyKeys) return _legacyKeys;
  _legacyKeys = [];

  // macOS hardware UUID, the old primary derivation.
  try {
    const output = execSync('system_profiler SPHardwareDataType', { encoding: 'utf8', timeout: 5000 });
    const match = output.match(/Hardware UUID:\s*([A-F0-9-]+)/i);
    if (match && match[1]) {
      _legacyKeys.push(crypto.createHash('sha256').update(match[1].trim()).digest());
    }
  } catch (_err) {
    // Not a Mac, or system_profiler unavailable - nothing to add.
  }

  // The hardcoded fallback every non-Mac install ended up using.
  _legacyKeys.push(crypto.createHash('sha256').update(LEGACY_FALLBACK_SECRET).digest());

  return _legacyKeys;
}

function encryptWithKey(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Packed as: iv (12) | authTag (16) | ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptWithKey(ciphertext, key) {
  const packed = Buffer.from(ciphertext, 'base64');
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Encrypt a string. Always uses the current key. */
function encrypt(plaintext) {
  return encryptWithKey(plaintext, getKey());
}

/**
 * Decrypt a string produced by encrypt(), including by the previous key
 * scheme.
 *
 * GCM authentication makes the fallback safe: a wrong key fails to
 * authenticate rather than returning plausible-looking garbage, so trying
 * several keys cannot silently produce the wrong plaintext.
 */
function decrypt(ciphertext) {
  try {
    return decryptWithKey(ciphertext, getKey());
  } catch (_err) {
    for (const legacyKey of getLegacyKeys()) {
      try {
        return decryptWithKey(ciphertext, legacyKey);
      } catch (_legacyErr) { /* try the next one */ }
    }
    throw new Error('Could not decrypt value with the current or any legacy key');
  }
}

/** True if this value decrypts under the current key (not a legacy one). */
function isCurrentKey(ciphertext) {
  try {
    decryptWithKey(ciphertext, getKey());
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Re-encrypt anything still stored under a legacy key.
 *
 * Idempotent, and each item is isolated: one failure cannot cascade and leave
 * the rest half-migrated. Values that already use the current key are skipped
 * without being rewritten, so this is cheap to call on every boot.
 *
 * @returns {{migrated: string[], failed: {item: string, error: string}[]}}
 */
function migrateLegacySecrets() {
  const migrated = [];
  const failed = [];

  // Encrypted OAuth/API tokens.
  let tokenRows = [];
  try {
    tokenRows = db.getAllTokenProviders ? db.getAllTokenProviders() : [];
  } catch (_err) { /* handled below */ }

  for (const provider of tokenRows) {
    try {
      const row = db.getToken(provider);
      if (!row || !row.token_data) continue;
      if (isCurrentKey(row.token_data)) continue;
      const plaintext = decrypt(row.token_data);
      db.setToken(provider, encrypt(plaintext), row.expires_at, row.account_info);
      migrated.push(`token:${provider}`);
    } catch (err) {
      failed.push({ item: `token:${provider}`, error: err.message });
    }
  }

  // Encrypted settings. Listed explicitly rather than guessed at, so a plain
  // setting that happens to look like base64 is never mangled.
  // NOTE: only settings genuinely written through encrypt() belong here.
  // openrouter_api_key looks like a secret but is stored and read as plaintext
  // (see services/aiInsights.js), so listing it produced a permanent phantom
  // "could not decrypt" failure on every run.
  const ENCRYPTED_SETTINGS = [
    'ical_password_enc',
    'ical_username_enc',
    'melcloud_email_enc',
    'melcloud_password_enc',
    'melview_email_enc',
    'melview_password_enc',
  ];

  for (const key of ENCRYPTED_SETTINGS) {
    try {
      const value = db.getSetting(key);
      if (!value) continue;
      if (isCurrentKey(value)) continue;
      db.setSetting(key, encrypt(decrypt(value)));
      migrated.push(`setting:${key}`);
    } catch (err) {
      failed.push({ item: `setting:${key}`, error: err.message });
    }
  }

  return { migrated, failed };
}

module.exports = { encrypt, decrypt, isCurrentKey, migrateLegacySecrets };
