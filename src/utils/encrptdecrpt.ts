import * as crypto from 'crypto';

// AES Encryption/Decryption setup
const algorithm = 'aes-256-gcm';
const ivLength: number = 12; // 12-byte IV for AES-GCM
const key: any = crypto
  .createHash('sha256')
  .update(process.env.ENCRYPTION_KEY || 'your-default-key')
  .digest(); // Ensure this is 32 bytes
const secret = process.env.HASH_SECRET || 'your-hash-secret-key';
// Encrypt a string using AES-256-GCM
function encrypt(value: string): string {
  const iv: any = crypto.randomBytes(ivLength);
  const cipher: any = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return (
    iv.toString('hex') +
    '.' +
    tag.toString('hex') +
    '.' +
    encrypted.toString('hex')
  );
}

// Decrypt a string using AES-256-GCM
function decrypt(encryptedValue: string): string {
  if (!isHexStructure(encryptedValue)) {
    return encryptedValue;
  }
  const [ivHex, tagHex, dataHex] = encryptedValue.split('.');
  const iv: any = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const decipher: any = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}
function isHexEncoded(value: string): boolean {
  const hexRegex = /^[a-fA-F0-9]+$/; // Only valid hexadecimal characters (0-9, a-f)
  return hexRegex.test(value);
}

function isHexStructure(value: string): boolean {
  // Split the value by the period (.) character into parts
  const parts = value.split('.');
  // Ensure we have exactly 3 parts (iv, tag, data), as this matches the encrypted structure
  if (parts.length !== 3) {
    return false;
  }
  return parts.every((part) => isHexEncoded(part));
}

// Hash a string using HMAC-SHA256 (deterministic)
function hash(value: string): string {
  value = value.toLowerCase().trim();
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

// Process a single value: encrypt, decrypt, or hash it
function processValue(
  value: string,
  type: 'encrypt' | 'decrypt' | 'hash',
): string {
  switch (type) {
    case 'encrypt':
      return encrypt(value);
    case 'decrypt':
      return decrypt(value);
    case 'hash':
      if (!secret) throw new Error('Hash requires a secret key.');
      return hash(value);
    default:
      throw new Error('Invalid type. Must be "encrypt", "decrypt", or "hash".');
  }
}

// Process an entire object: encrypt, decrypt, or hash specific fields
function processObject(obj: any, type: 'encrypt' | 'decrypt' | 'hash'): any {
  const processedObj: any = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      processedObj[key] = processValue(value, type); // Process individual string fields
    } else if (typeof value === 'object' && value !== null && key !== '_id') {
      processedObj[key] = processObject(value, type); // Recurse if object
    } else {
      processedObj[key] = value; // Copy other data types (e.g., numbers)
    }
  }

  return processedObj;
}

export { encrypt, decrypt, hash, processValue, processObject };
