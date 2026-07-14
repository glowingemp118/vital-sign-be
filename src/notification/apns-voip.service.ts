import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as http2 from 'http2';
import { sign } from 'jsonwebtoken';

export type VoipPushPayload = {
  uuid: string;
  callUUID: string;
  handle: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  callType: 'audio' | 'video';
  type: string;
};

/**
 * APNs VoIP sender.
 * Preferred: direct VoIP Services certificate (.pem or .p12) via mTLS.
 * Fallback: Auth Key (.p8) token auth.
 */
@Injectable()
export class ApnsVoipService {
  private readonly logger = new Logger(ApnsVoipService.name);
  private cachedJwt: { token: string; exp: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private hasCertAuth(): boolean {
    const pem =
      this.config.get<string>('APNS_CERT_PATH') ||
      this.config.get<string>('APNS_CERT_PEM') ||
      this.config.get<string>('APNS_CERT_P12_PATH');
    const bundleId = this.config.get<string>('APNS_BUNDLE_ID');
    return !!(pem && bundleId);
  }

  private hasTokenAuth(): boolean {
    const keyId = this.config.get<string>('APNS_KEY_ID');
    const teamId = this.config.get<string>('APNS_TEAM_ID');
    const key =
      this.config.get<string>('APNS_KEY_CONTENT') ||
      this.config.get<string>('APNS_KEY_PATH');
    const bundleId = this.config.get<string>('APNS_BUNDLE_ID');
    return !!(keyId && teamId && bundleId && key);
  }

  isConfigured(): boolean {
    return this.hasCertAuth() || this.hasTokenAuth();
  }

  private host(): string {
    const production =
      this.config.get<string>('APNS_PRODUCTION') === 'true' ||
      this.config.get<string>('APNS_PRODUCTION') === '1';
    return production
      ? 'api.push.apple.com'
      : 'api.sandbox.push.apple.com';
  }

  private readFileOrContent(pathKey: string, contentKey: string): string | null {
    const content = this.config.get<string>(contentKey);
    if (content) return content.replace(/\\n/g, '\n');
    const filePath = this.config.get<string>(pathKey);
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return null;
  }

  /** TLS options for direct VoIP certificate (PEM or P12). */
  private getCertTlsOptions(): http2.SecureClientSessionOptions {
    // .p12 / PKCS#12
    const p12Path = this.config.get<string>('APNS_CERT_P12_PATH');
    if (p12Path) {
      if (!fs.existsSync(p12Path)) {
        throw new Error(`APNS_CERT_P12_PATH not found: ${p12Path}`);
      }
      const pfx = fs.readFileSync(p12Path);
      const passphrase =
        this.config.get<string>('APNS_CERT_PASSPHRASE') ||
        this.config.get<string>('APNS_P12_PASSWORD') ||
        '';
      return {
        pfx,
        passphrase,
        servername: this.host(),
        rejectUnauthorized: true,
      };
    }

    // PEM: cert + key (VoIP Services cert exported to PEM)
    const cert =
      this.readFileOrContent('APNS_CERT_PATH', 'APNS_CERT_PEM') ||
      this.readFileOrContent('APNS_CERT_PEM_PATH', 'APNS_CERT_PEM');
    const key =
      this.readFileOrContent('APNS_CERT_KEY_PATH', 'APNS_CERT_KEY_PEM') ||
      cert; // sometimes cert+key in one PEM file

    if (!cert) {
      throw new Error(
        'VoIP certificate not found — set APNS_CERT_P12_PATH or APNS_CERT_PATH (+ APNS_CERT_KEY_PATH)',
      );
    }

    return {
      cert,
      key: key || cert,
      servername: this.host(),
      rejectUnauthorized: true,
    };
  }

  private getPrivateKey(): string {
    const content = this.config.get<string>('APNS_KEY_CONTENT');
    if (content) return content.replace(/\\n/g, '\n');
    return fs.readFileSync(this.config.getOrThrow<string>('APNS_KEY_PATH'), 'utf8');
  }

  private getProviderToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedJwt && this.cachedJwt.exp - 60 > now) {
      return this.cachedJwt.token;
    }

    const keyId = this.config.getOrThrow<string>('APNS_KEY_ID');
    const teamId = this.config.getOrThrow<string>('APNS_TEAM_ID');
    const privateKey = this.getPrivateKey();
    const exp = now + 3500;

    const token = sign({ iss: teamId, iat: now }, privateKey, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId },
      noTimestamp: true,
    });

    this.cachedJwt = { token, exp };
    return token;
  }

  private buildBody(payload: VoipPushPayload) {
    return {
      aps: { 'content-available': 1 },
      uuid: String(payload.uuid),
      callUUID: String(payload.callUUID),
      handle: String(payload.handle),
      callerId: String(payload.callerId),
      callerName: String(payload.callerName || 'Unknown'),
      callerAvatar: String(payload.callerAvatar || ''),
      callType: String(payload.callType || 'audio'),
      type: String(payload.type || 'incoming_call'),
    };
  }

  /**
   * Send APNs VoIP push (PushKit). Topic = `<bundleId>.voip`
   * Uses direct certificate when configured.
   */
  async sendVoipPush(voipToken: string, payload: VoipPushPayload): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.warn(
        '[VoIP] APNs not configured — set APNS_CERT_P12_PATH (or APNS_CERT_PATH) + APNS_BUNDLE_ID',
      );
      return false;
    }

    const bundleId = this.config.getOrThrow<string>('APNS_BUNDLE_ID');
    const topic =
      this.config.get<string>('APNS_VOIP_TOPIC')?.trim() ||
      `${bundleId}.voip`;
    const host = this.host();
    const deviceToken = voipToken.replace(/\s/g, '');
    const body = this.buildBody(payload);
    const expiration = Math.floor(Date.now() / 1000) + 60;

    const useCert = this.hasCertAuth();
    this.logger.log(
      `[VoIP] sending via ${useCert ? 'certificate' : 'token'} topic=${topic} host=${host} tokenLen=${deviceToken.length}`,
    );

    return new Promise((resolve) => {
      let client: http2.ClientHttp2Session;

      try {
        if (useCert) {
          const tlsOpts = this.getCertTlsOptions();
          client = http2.connect(`https://${host}`, tlsOpts);
        } else {
          client = http2.connect(`https://${host}`);
        }
      } catch (err: any) {
      const msg = err?.message || String(err);
      if (/mac verify failure|invalid password|bad decrypt/i.test(msg)) {
        this.logger.error(
          `[VoIP] connect setup failed: ${msg} — APNS_CERT_PASSPHRASE is wrong or .p12 is corrupt. Fix password in .env and restart.`,
        );
      } else {
        this.logger.error(`[VoIP] connect setup failed: ${msg}`);
      }
      resolve(false);
      return;
    }

      client.on('error', (err) => {
        this.logger.error(`[VoIP] APNs connection error: ${err.message}`);
        try {
          client.close();
        } catch {
          /* ignore */
        }
        resolve(false);
      });

      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        'apns-topic': topic,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': String(expiration),
        'content-type': 'application/json',
      };

      // Token auth only when not using cert mTLS
      if (!useCert) {
        headers.authorization = `bearer ${this.getProviderToken()}`;
      }

      const req = client.request(headers);

      let responseData = '';
      let status = 0;

      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status'] || 0);
      });

      req.on('data', (chunk) => {
        responseData += chunk;
      });

      req.on('end', () => {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        if (status === 200) {
          this.logger.log(
            `[VoIP] APNs success token=...${deviceToken.slice(-8)} topic=${topic}`,
          );
          resolve(true);
        } else {
          this.logger.error(
            `[VoIP] APNs failed status=${status} body=${responseData} topic=${topic}. ` +
              (responseData.includes('DeviceTokenNotForTopic')
                ? 'Token was NOT registered for this VoIP topic — app Bundle ID must be com.mexidoc and voip_token must be PushKit (not FCM/APNs regular).'
                : ''),
          );
          resolve(false);
        }
      });

      req.on('error', (err) => {
        this.logger.error(`[VoIP] APNs request error: ${err.message}`);
        try {
          client.close();
        } catch {
          /* ignore */
        }
        resolve(false);
      });

      req.end(JSON.stringify(body));
    });
  }
}
