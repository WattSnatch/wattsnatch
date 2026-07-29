/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Passphrase-based AES-256-GCM for backup files - deliberately separate from
// src/utils/crypto.js, which derives its key from this machine's hardware
// UUID and is meant for at-rest encryption of things that never leave this
// machine (OAuth tokens in the DB). A backup is exactly the opposite case:
// it's protected precisely *because* it might leave the machine (cloud sync,
// USB drive, email), so it must be decryptable from a password alone.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
// N=16384 is scrypt's standard "interactive" cost parameter (~16MB of
// memory) - comfortably under Node's default 32MB scrypt memory limit,
// while still being far stronger than a plain salted hash.
const SCRYPT_OPTS = { N: 2 ** 14, r: 8, p: 1 };

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_OPTS);
}

// Returns a Buffer: salt(16) | iv(12) | authTag(16) | ciphertext
function encryptBuffer(plainBuffer, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

// Reverses encryptBuffer(). Throws if the password is wrong or the data is
// corrupted/truncated (GCM auth tag verification fails).
function decryptBuffer(packed, password) {
  if (packed.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Not a valid encrypted backup file (too short).');
  }
  const salt = packed.subarray(0, SALT_LEN);
  const iv = packed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = packed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const encrypted = packed.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (_err) {
    throw new Error('Wrong password, or the file is corrupted.');
  }
}

module.exports = { encryptBuffer, decryptBuffer };
