import { Controller, Get, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('app/webrtc')
export class WebrtcController {
  constructor(private readonly config: ConfigService) {}

  /**
   * GET /api/app/webrtc/ice-servers
   * Returns STUN/TURN config for WebRTC peer connections.
   */
  @Get('ice-servers')
  getIceServers(@Req() _req: any) {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    const turnUrl = this.config.get<string>('TURN_URL');
    const turnUsername = this.config.get<string>('TURN_USERNAME');
    const turnCredential = this.config.get<string>('TURN_CREDENTIAL');

    if (turnUrl && turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      });
    }

    return {
      iceServers,
      ttl: 86400,
    };
  }
}
