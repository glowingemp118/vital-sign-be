import { Controller, Get, Logger, Req } from '@nestjs/common';
import { WebrtcService } from './webrtc.service';

@Controller('app/webrtc')
export class WebrtcController {
  private readonly logger = new Logger(WebrtcController.name);

  constructor(private readonly webrtcService: WebrtcService) {}

  /**
   * GET /api/app/webrtc/ice-servers
   * Returns STUN + TURN for WebRTC (same list for web and mobile).
   * Prefer Twilio NTS, else coturn ephemeral (TURN_SECRET), else static TURN_*.
   */
  @Get('ice-servers')
  async getIceServers(@Req() req: any) {
    const userId =
      req?.user?._id?.toString() ||
      req?.user?.id?.toString() ||
      req?.user?.sub?.toString() ||
      undefined;

    const result = await this.webrtcService.getIceServers(userId);

    if (!result.hasTurn) {
      this.logger.error(
        '[WebRTC] GET ice-servers returning STUN-only — production web↔mobile will fail after answer',
      );
    }

    return {
      iceServers: result.iceServers,
      ttl: result.ttl,
      provider: result.provider,
      hasTurn: result.hasTurn,
    };
  }
}
