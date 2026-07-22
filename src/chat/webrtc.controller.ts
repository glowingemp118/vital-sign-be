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

    const startedAt = Date.now();
    this.logger.log(`[WebRTC] GET ice-servers start user=${userId || 'anon'}`);

    try {
      const result = await this.webrtcService.getIceServers(userId);

      if (!result.hasTurn) {
        this.logger.error(
          `[WebRTC] GET ice-servers STUN-only user=${userId || 'anon'} provider=${result.provider} elapsedMs=${Date.now() - startedAt} — production web↔mobile may fail after answer`,
        );
      } else {
        this.logger.log(
          `[WebRTC] GET ice-servers ok user=${userId || 'anon'} provider=${result.provider} hasTurn=true servers=${result.iceServers?.length || 0} elapsedMs=${Date.now() - startedAt}`,
        );
      }

      return {
        iceServers: result.iceServers,
        ttl: result.ttl,
        provider: result.provider,
        hasTurn: result.hasTurn,
      };
    } catch (err: any) {
      this.logger.error(
        `[WebRTC] GET ice-servers FAILED user=${userId || 'anon'} elapsedMs=${Date.now() - startedAt} err=${err?.message || err}`,
        err?.stack,
      );
      throw err;
    }
  }
}
