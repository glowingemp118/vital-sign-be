import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { SocketService } from './socket.services';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from 'src/user/schemas/user.schema';
import { NotificationService } from 'src/notification/notification.service';
import {
  NOTIFICATION_CONFIG,
  NOTIFICATION_TYPE,
} from 'src/constants/constants';
import { processValue } from '../utils/encrptdecrpt';

// Interface for call event payloads
interface CallUserPayload {
  targetUserId: string;
  offer: any;
}

interface AnswerCallPayload {
  targetUserId: string;
  answer: any;
}

interface IceCandidatePayload {
  targetUserId: string;
  candidate: any;
}

interface CallActionPayload {
  targetUserId: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly socketService: SocketService,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly notificationService: NotificationService,
  ) {}

  @WebSocketServer() server!: Server;

  // Active call map: userId -> partnerId (bidirectional call lock)
  private activeCallMap = new Map<string, string>();

  afterInit() {
    // 👇 PASS IT TO SERVICE
    this.socketService.setServer(this.server);
  }

  // Helper: Set bidirectional call pair
  private setCallPair(a: string, b: string) {
    this.activeCallMap.set(String(a), String(b));
    this.activeCallMap.set(String(b), String(a));
  }

  // Helper: Clear call pair
  private clearCallPair(a: string, b: string) {
    this.activeCallMap.delete(String(a));
    this.activeCallMap.delete(String(b));
  }

  // Helper: Get partner user ID for a given user
  private getPartner(userId: string): string | null {
    return this.activeCallMap.get(String(userId)) || null;
  }

  // Helper: Check if user is currently in a call
  private isUserBusy(userId: string): boolean {
    return !!this.activeCallMap.get(String(userId));
  }

  // Helper: Get user room (all devices of a user join this room)
  private getUserRoom(userId: string): string {
    return `user_${userId}`;
  }

  // Helper: Get full image URL
  private getFullImageUrl(imageName: string | undefined): string {
    if (!imageName || imageName === 'noimage.png') return '';
    return `${process.env.IB_URL || ''}${imageName}`;
  }

  // Method for handling socket connection
  async handleConnection(socket: Socket) {
    const { subjectId, objectId, type } = socket.handshake.query;

    const subjectIdString = Array.isArray(subjectId) ? subjectId[0] : subjectId;
    const objectIdString = Array.isArray(objectId) ? objectId[0] : objectId;

    // subjectId is REQUIRED
    if (!subjectIdString || !Types.ObjectId.isValid(subjectIdString)) {
      const errorMessage =
        'subjectId must be provided in query parameters and must be a valid ObjectId.';
      socket.emit('error', { message: errorMessage });
      return;
    }

    // objectId is OPTIONAL — validate only if provided
    if (objectIdString && !Types.ObjectId.isValid(objectIdString)) {
      const errorMessage = 'objectId must be a valid ObjectId if provided.';
      socket.emit('error', { message: errorMessage });
      return;
    }

    const connectionType =
      type === 'group' ? 'group' : objectIdString ? 'direct' : 'self';
    console.log(`Connection type determined: ${connectionType}`);
    socket.join(`user_${subjectIdString}`);
    try {
      const connection = await this.socketService.createOrUpdateConnection({
        subjectId: subjectIdString,
        objectId: objectIdString || null, // 👈 optional
        socketId: socket.id,
        type: connectionType,
      });

      console.log(`Socket connection created or updated`);
    } catch (error) {
      console.error(`Error creating/updating socket connection:`, error);
    }
  }

  // Method for handling socket disconnection
  async handleDisconnect(socket: Socket) {
    const { subjectId, objectId, type } = socket.handshake.query;

    const subjectIdString = Array.isArray(subjectId) ? subjectId[0] : subjectId;
    const objectIdString = Array.isArray(objectId) ? objectId[0] : objectId;

    const connectionType = type === 'group' ? 'group' : 'direct';
    console.log(`User ${subjectIdString} disconnected.`);

    // Clean up active call if user disconnects during a call
    if (subjectIdString) {
      const partnerId = this.getPartner(subjectIdString);
      if (partnerId) {
        this.clearCallPair(subjectIdString, partnerId);
        // Notify the partner that the call has ended
        this.server.to(this.getUserRoom(partnerId)).emit('callEnded', {
          by: subjectIdString,
        });
      }
    }

    await this.socketService.deleteConnectionByUserId(
      subjectIdString,
      connectionType === 'group' ? objectIdString || null : null,
      connectionType,
    );

    console.log(
      `User ${subjectIdString} removed from ${connectionType} active connections.`,
    );
  }

  // ==========================
  // CALL EVENTS
  // ==========================

  // CALL INITIATE - Start a WebRTC call
  @SubscribeMessage('callUser')
  async handleCallUser(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallUserPayload,
  ) {
    let callerId = socket.handshake.query.subjectId as string;
    let calleeId = payload.targetUserId ? String(payload.targetUserId) : null;

    if (!callerId) {
      socket.emit('error', { message: 'Caller ID is required' });
      return;
    }

    if (!calleeId) {
      socket.emit('error', { message: 'Target user ID is required' });
      return;
    }

    console.log(`[CALL] ${callerId} -> ${calleeId}`);

    // Check if either user is already in a call
    if (this.isUserBusy(callerId) || this.isUserBusy(calleeId)) {
      this.server.to(this.getUserRoom(callerId)).emit('callBusy', {
        targetUserId: calleeId,
        reason: 'user_in_call',
      });
      return;
    }
    console.log(`[CALL INITIATED] ${callerId} -> ${calleeId}`);
    // Fetch caller information
    const caller = await this.userModel
      .findById(callerId)
      .select('name image')
      .lean();

    caller.name = processValue(caller?.name, 'decrypt');

    console.log(`[CALLER INFO]`, caller);
    // Send incoming call to all devices of the callee
    this.server.to(this.getUserRoom(calleeId)).emit('incomingCall', {
      callerId,
      callerName: caller?.name || 'Unknown',
      callerAvatar: this.getFullImageUrl(caller?.image) || '',
      offer: payload.offer,
    });

    // Send push notification to callee if they're offline
    try {
      await this.notificationService.sendNotification({
        userId: calleeId,
        title: 'Incoming Call',
        message: `${caller?.name || 'Someone'} is calling you`,
        type: NOTIFICATION_TYPE.CALL_MISSED,
        object: {
          type: 'incoming_call',
          callerId,
          callerName: caller?.name || 'Unknown',
          callerAvatar: this.getFullImageUrl(caller?.image) || '',
          offer: JSON.stringify(payload.offer),
        },
      });
    } catch (err: any) {
      console.error('Error sending call notification:', err?.message || err);
    }
  }

  // CALL ACCEPT - Accept an incoming call
  @SubscribeMessage('answerCall')
  handleAnswerCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: AnswerCallPayload,
  ) {
    const calleeId = socket.handshake.query.subjectId as string;
    const callerId = String(payload.targetUserId);

    if (!calleeId) {
      socket.emit('error', { message: 'Callee ID is required' });
      return;
    }

    console.log(`[CALL ANSWERED] ${calleeId} -> ${callerId}`);

    // Prevent duplicate answer
    if (this.getPartner(callerId) || this.getPartner(calleeId)) {
      return;
    }

    // Set bidirectional call lock
    this.setCallPair(callerId, calleeId);

    // Send answer to caller (all caller devices)
    this.server.to(this.getUserRoom(callerId)).emit('callAnswered', {
      answer: payload.answer,
      calleeId,
    });

    // Notify all OTHER devices of the callee to dismiss incoming call screen
    // e.g., user is logged in on phone + tablet — tablet answered,
    // phone must dismiss its IncomingCallScreen without emitting rejectCall
    socket.to(this.getUserRoom(calleeId)).emit('callAnsweredElsewhere', {
      callerId,
    });
  }

  // ICE CANDIDATE - Exchange ICE candidates for WebRTC connection
  @SubscribeMessage('iceCandidate')
  handleIceCandidate(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: IceCandidatePayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId) {
      socket.emit('error', { message: 'From user ID is required' });
      return;
    }

    this.server.to(this.getUserRoom(targetUserId)).emit('iceCandidate', {
      candidate: payload.candidate,
      fromUserId,
    });
  }

  // REJECT CALL - Reject an incoming call
  @SubscribeMessage('rejectCall')
  handleRejectCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const callerId = String(payload.targetUserId);
    const rejecterId = socket.handshake.query.subjectId as string;

    if (!rejecterId) {
      socket.emit('error', { message: 'Rejecter ID is required' });
      return;
    }

    console.log(`[CALL REJECTED] ${rejecterId} -> ${callerId}`);

    // Clear any existing call pairs
    const partner = this.getPartner(rejecterId);
    if (partner) {
      this.clearCallPair(rejecterId, partner);
      this.clearCallPair(partner, rejecterId);
    }

    this.clearCallPair(rejecterId, callerId);
    this.clearCallPair(callerId, rejecterId);

    // Notify caller that call was rejected
    this.server.to(this.getUserRoom(callerId)).emit('callRejected', {
      by: rejecterId,
    });

    // Also dismiss IncomingCallScreen on other devices of the rejecter
    socket.to(this.getUserRoom(rejecterId)).emit('callAnsweredElsewhere', {
      callerId,
    });
  }

  // END CALL - End an active call
  @SubscribeMessage('endCall')
  handleEndCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const otherUserId = String(payload.targetUserId);
    const userId = socket.handshake.query.subjectId as string;

    if (!userId) {
      socket.emit('error', { message: 'User ID is required' });
      return;
    }

    console.log(`[CALL ENDED] ${userId} <-> ${otherUserId}`);

    const partner = this.getPartner(userId);

    // Clear call pair with actual partner
    if (partner) {
      this.clearCallPair(userId, partner);
    }

    // Clear call pair with target user
    this.clearCallPair(userId, otherUserId);
    this.clearCallPair(otherUserId, userId);

    // Notify the other user that call has ended
    this.server.to(this.getUserRoom(otherUserId)).emit('callEnded', {
      by: userId,
    });

    // If there was a different partner, notify them too
    if (partner && partner !== otherUserId) {
      this.server.to(this.getUserRoom(partner)).emit('callEnded', {
        by: userId,
      });
    }
  }
}
