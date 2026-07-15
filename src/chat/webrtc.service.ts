import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

@Injectable()
export class WebrtcService {
  private readonly logger = new Logger(WebrtcService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Build ICE servers for web + mobile.
   * Priority:
   * 1) Twilio Network Traversal (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN)
   * 2) coturn time-limited HMAC (TURN_SECRET + TURN_HOST)
   * 3) static TURN_URL / TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
   * Always includes public STUN fallbacks.
   */
  async getIceServers(userId?: string): Promise<{
    iceServers: IceServer[];
    ttl: number;
    provider: string;
    hasTurn: boolean;
  }> {
    const stunFallbacks: IceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    const twilio = await this.fromTwilio();
    if (twilio) {
      return this.finalize(twilio.iceServers, twilio.ttl, 'twilio', stunFallbacks);
    }

    const coturnEphemeral = this.fromCoturnSecret(userId);
    if (coturnEphemeral) {
      return this.finalize(
        coturnEphemeral.iceServers,
        coturnEphemeral.ttl,
        'coturn-ephemeral',
        stunFallbacks,
      );
    }

    const staticTurn = this.fromStaticTurn();
    if (staticTurn) {
      return this.finalize(
        staticTurn.iceServers,
        staticTurn.ttl,
        'static-turn',
        stunFallbacks,
      );
    }

    this.logger.error(
      '[WebRTC] No TURN configured — set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN ' +
        'or TURN_SECRET+TURN_HOST or TURN_URL(S)+TURN_USERNAME+TURN_CREDENTIAL. ' +
        'Web↔mobile calls will fail off-LAN.',
    );

    return {
      iceServers: stunFallbacks,
      ttl: 86400,
      provider: 'stun-only',
      hasTurn: false,
    };
  }

  private finalize(
    servers: IceServer[],
    ttl: number,
    provider: string,
    stunFallbacks: IceServer[],
  ) {
    const iceServers = this.mergeIceServers(stunFallbacks, servers);
    const hasTurn = iceServers.some((s) => this.hasTurnUrl(s.urls));
    if (!hasTurn) {
      this.logger.error(
        `[WebRTC] provider=${provider} returned no turn:/turns: URLs — check credentials`,
      );
    } else {
      this.logger.log(
        `[WebRTC] ICE ready provider=${provider} servers=${iceServers.length} hasTurn=true ttl=${ttl}`,
      );
    }
    return { iceServers, ttl, provider, hasTurn };
  }

  private hasTurnUrl(urls: string | string[]): boolean {
    const list = Array.isArray(urls) ? urls : [urls];
    return list.some((u) => /^turns?:/i.test(String(u || '')));
  }

  private mergeIceServers(base: IceServer[], extra: IceServer[]): IceServer[] {
    const seen = new Set<string>();
    const out: IceServer[] = [];
    for (const s of [...extra, ...base]) {
      const key = JSON.stringify({
        urls: s.urls,
        username: s.username || '',
      });
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  /** Twilio Network Traversal Service — full ice_servers (STUN + TURN). */
  private async fromTwilio(): Promise<{ iceServers: IceServer[]; ttl: number } | null> {
    const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim();
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim();
    if (!accountSid || !authToken) return null;

    const ttl = Number(this.config.get<string>('TWILIO_TURN_TTL') || 86400);
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `Ttl=${ttl}`,
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`[WebRTC] Twilio NTS failed status=${res.status} body=${body.slice(0, 300)}`);
        return null;
      }

      const data: any = await res.json();
      const iceServers: IceServer[] = (data.ice_servers || []).map((s: any) => ({
        urls: s.urls || s.url,
        ...(s.username ? { username: s.username } : {}),
        ...(s.credential ? { credential: s.credential } : {}),
      }));

      if (!iceServers.length) {
        this.logger.error('[WebRTC] Twilio NTS returned empty ice_servers');
        return null;
      }

      return {
        iceServers,
        ttl: Number(data.ttl || ttl),
      };
    } catch (err: any) {
      this.logger.error(`[WebRTC] Twilio NTS error: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * coturn time-limited credentials (static-auth-secret / use-auth-secret).
   * username = `<expiry>:<userId>`
   * credential = base64(HMAC-SHA1(secret, username))
   */
  private fromCoturnSecret(userId?: string): {
    iceServers: IceServer[];
    ttl: number;
  } | null {
    const secret = this.config.get<string>('TURN_SECRET')?.trim();
    const host =
      this.config.get<string>('TURN_HOST')?.trim() ||
      this.config.get<string>('TURN_DOMAIN')?.trim();
    if (!secret || !host) return null;

    const ttl = Number(this.config.get<string>('TURN_TTL') || 86400);
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${userId || 'webrtc'}`;
    const credential = crypto
      .createHmac('sha1', secret)
      .update(username)
      .digest('base64');

    const urls = this.buildCoturnUrls(host);
    return {
      iceServers: urls.map((u) => ({
        urls: u,
        username,
        credential,
      })),
      ttl,
    };
  }

  private buildCoturnUrls(host: string): string[] {
    const configured = this.parseTurnUrls(
      this.config.get<string>('TURN_URLS') || this.config.get<string>('TURN_URL'),
    );
    if (configured.length) return configured;

    // Defaults: UDP+TCP 3478 only (5349/TLS often firewalled — omit unless TURN_TLS_PORT set and TURN_ENABLE_TLS=true)
    const urls = [
      `turn:${host}:3478?transport=udp`,
      `turn:${host}:3478?transport=tcp`,
    ];
    const enableTls =
      String(this.config.get<string>('TURN_ENABLE_TLS') || '').toLowerCase() ===
      'true';
    if (enableTls) {
      const tlsPort = this.config.get<string>('TURN_TLS_PORT')?.trim() || '5349';
      urls.push(`turns:${host}:${tlsPort}?transport=tcp`);
    }
    return urls;
  }

  /** Static long-lived TURN username/password from env. */
  private fromStaticTurn(): { iceServers: IceServer[]; ttl: number } | null {
    const username = this.config.get<string>('TURN_USERNAME')?.trim();
    const credential = this.config.get<string>('TURN_CREDENTIAL')?.trim();
    const urls = this.parseTurnUrls(
      this.config.get<string>('TURN_URLS') || this.config.get<string>('TURN_URL'),
    );

    const host =
      this.config.get<string>('TURN_HOST')?.trim() ||
      this.config.get<string>('TURN_DOMAIN')?.trim();
    const finalUrls =
      urls.length > 0
        ? urls
        : host
          ? this.buildCoturnUrls(host)
          : [];

    if (!username || !credential || !finalUrls.length) return null;

    // One RTCIceServer per URL — better Android compatibility than urls[]
    const iceServers: IceServer[] = finalUrls.map((u) => ({
      urls: u,
      username,
      credential,
    }));

    return {
      iceServers,
      ttl: Number(this.config.get<string>('TURN_TTL') || 86400),
    };
  }

  private parseTurnUrls(raw?: string | null): string[] {
    if (!raw?.trim()) return [];
    return raw
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
  }
}
