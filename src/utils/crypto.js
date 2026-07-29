/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

let _key = null;

function getDerivedKey() {
  if (_key) return _key;

  try {
    const output = execSync('system_profiler SPHardwareDataType', { encoding: 'utf8', timeout: 5000 });
    const match = output.match(/Hardware UUID:\s*([A-F0-9-]+)/i);
    if (match && match[1]) {
      const uuid = match[1].trim();
      _key = crypto.createHash('sha256').update(uuid).digest();
      return _key;
    }
  } catch (_err) {
    // Fall through to default key
  }

  // Fallback for non-Mac / dev environments
  const fallback = 'solarcharge-dev-key-do-not-use-in-production-env';
  _key = crypto.createHash('sha256').update(fallback).digest();
  return _key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: iv(12) + authTag(16) + ciphertext.
 */
function encrypt(plaintext) {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) | authTag (16) | ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded string produced by encrypt().
 */
function decrypt(ciphertext) {
  const key = getDerivedKey();
  const packed = Buffer.from(ciphertext, 'base64');

  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
