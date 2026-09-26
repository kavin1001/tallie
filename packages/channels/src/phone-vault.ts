import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** Versioned local development encryption. Production key rotation is a separate gate. */
export class PhoneVault {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(secret: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(secret))
      throw new Error('Invalid phone encryption configuration.');
    const input = Buffer.from(secret, 'hex');
    this.encryptionKey = Buffer.from(
      hkdfSync('sha256', input, 'tallie', 'phone-encryption-v1', 32),
    );
    this.lookupKey = Buffer.from(hkdfSync('sha256', input, 'tallie', 'phone-lookup-v1', 32));
  }

  lookup(phone: string): string {
    return createHmac('sha256', this.lookupKey).update(phone).digest('hex');
  }

  seal(value: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(value: string, context: string): string {
    const [version, nonce, tag, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !tag || !ciphertext || extra)
      throw new Error('Invalid encrypted phone record.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
