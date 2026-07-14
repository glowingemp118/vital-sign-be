import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { CallSessionService } from './call-session.service';

@Controller('calls')
export class CallsController {
  constructor(private readonly callSessionService: CallSessionService) {}

  /**
   * GET /api/calls/:uuid
   * After CallKit Accept, app fetches WebRTC offer (not sent in VoIP push).
   */
  @Get(':uuid')
  getCall(@Param('uuid') uuid: string, @Req() req: any) {
    const session = this.callSessionService.getOffer(uuid);
    if (!session) {
      throw new NotFoundException('Call session not found or expired');
    }

    const userId = String(req.user?._id || '');
    if (
      userId &&
      userId !== session.calleeId &&
      userId !== session.callerId
    ) {
      throw new NotFoundException('Call session not found or expired');
    }

    return {
      uuid: session.uuid,
      callUUID: session.uuid,
      callerId: session.callerId,
      callerName: session.callerName,
      callerAvatar: session.callerAvatar,
      callType: session.callType,
      offer: session.offer,
      type: 'incoming_call',
    };
  }
}
