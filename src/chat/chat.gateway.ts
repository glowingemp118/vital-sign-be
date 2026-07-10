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
type CallType = 'audio' | 'video';

interface CallUserPayload {
  targetUserId: string;
  offer: any;
  callType?: CallType;
}

interface AnswerCallPayload {
  targetUserId: string;
  answer: any;
  callType?: CallType;
}

interface IceCandidatePayload {
  targetUserId: string;
  candidate: any;
}

interface CallActionPayload {
  targetUserId: string;
  callType?: CallType;
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
  // Normalize any incoming callType to a strict 'audio' | 'video'
  private normalizeCallType(callType?: string): CallType {
    return callType === 'video' ? 'video' : 'audio';
  }
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

  // ADDED — Check two users are actually paired with each other right now.
  // Used to guard switch-to-video / renegotiation relays so a stray or
  // spoofed event can't be relayed into an unrelated call.
  private isActivePair(a: string, b: string): boolean {
    return this.getPartner(a) === String(b) && this.getPartner(b) === String(a);
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
    const subjectId = socket.handshake.query.subjectId as string;

    // End active call if needed
    const partnerId = this.getPartner(subjectId);
    if (partnerId) {
      this.clearCallPair(subjectId, partnerId);

      this.server.to(this.getUserRoom(partnerId)).emit('callEnded', {
        by: subjectId,
      });
    }

    // Remove only this socket connection
    await this.socketService.deleteConnectionBySocketId(socket.id);

    console.log(`Socket ${socket.id} disconnected and removed from database.`);
    // ✅ ADDED: chat presence cleanup — only when the user's last socket goes
    // if (!subjectId) return;

    // const isLastSocket = await this.markUserOffline(subjectId);
    // if (isLastSocket) {
    //   await this.emitStatusToConversationPeers({
    //     server: this.server,
    //     userId: subjectId,
    //     status: 'offline',
    //   });
    //   await this.clearConversationPeers(subjectId);
    // }
  }

  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = socket.handshake.query.subjectId as string;

    socket.join(`conversation_${payload.conversationId}`);

    await this.socketService.createOrUpdateConnection({
      subjectId: userId,
      objectId: payload.conversationId,
      socketId: socket.id,
      type: 'direct',
    });

    console.log(`${userId} joined ${payload.conversationId}`);
  }

  @SubscribeMessage('leaveConversation')
  async handleLeaveConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = socket.handshake.query.subjectId as string;

    socket.leave(`conversation_${payload.conversationId}`);

    await this.socketService.deleteConnectionBySocketId(socket.id);
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
    const callerId = socket.handshake.query.subjectId as string;
    const calleeId = payload.targetUserId ? String(payload.targetUserId) : null;

    if (!callerId) {
      socket.emit('error', { message: 'Caller ID is required' });
      return;
    }

    if (!calleeId) {
      socket.emit('error', { message: 'Target user ID is required' });
      return;
    }

    const callType = this.normalizeCallType(payload.callType);

    console.log(`[CALL:${callType}] ${callerId} -> ${calleeId}`);

    // Check if either user is already in a call
    if (this.isUserBusy(callerId) || this.isUserBusy(calleeId)) {
      this.server.to(this.getUserRoom(callerId)).emit('callBusy', {
        targetUserId: calleeId,
        reason: 'user_in_call',
        callType,
      });
      return;
    }

    // Fetch caller information
    const caller = await this.userModel
      .findById(callerId)
      .select('name image')
      .lean();

    if (caller) {
      caller.name = processValue(caller?.name, 'decrypt');
    }

    // Send incoming call to all devices of the callee
    this.server.to(this.getUserRoom(calleeId)).emit('incomingCall', {
      callerId,
      callerName: caller?.name || 'Unknown',
      callerAvatar: this.getFullImageUrl(caller?.image) || '',
      offer: payload.offer,
      callType,
    });

    const sockets = await this.socketService.getUserConnections(calleeId);
    if (!sockets || sockets.length === 0) {
      console.log(
        `[CALL NOTIFICATION] ${calleeId} is offline, sending push notification`,
      );

      try {
        await this.notificationService.sendNotification({
          userId: calleeId,
          title:
            callType === 'video'
              ? 'Incoming Video Call'
              : 'Incoming Audio Call',
          message: `${caller?.name || 'Someone'} is calling you`,
          type: NOTIFICATION_TYPE.CALL_MISSED,
          object: {
            type: 'incoming_call',
            callType,
            callerId,
            callerName: caller?.name || 'Unknown',
            callerAvatar: this.getFullImageUrl(caller?.image) || '',
            // offer: JSON.stringify(payload.offer),
          },
        });
      } catch (err: any) {
        console.error('Error sending call notification:', err?.message || err);
      }
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

    const callType = this.normalizeCallType(payload.callType);

    console.log(`[CALL ANSWERED:${callType}] ${calleeId} -> ${callerId}`);

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
      callType,
    });

    // Notify all OTHER devices of the callee to dismiss incoming call screen
    socket.to(this.getUserRoom(calleeId)).emit('callAnsweredElsewhere', {
      callerId,
      callType,
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

  // BUSY CALL - a device already in a call tells the caller it's busy
  // @SubscribeMessage('busyCall')
  // handleBusyCall(
  //   @ConnectedSocket() socket: Socket,
  //   @MessageBody() payload: CallActionPayload,
  // ) {
  //   const busyUserId = socket.handshake.query.subjectId as string;
  //   const callerId = String(payload.targetUserId);

  //   if (!busyUserId) {
  //     socket.emit('error', { message: 'User ID is required' });
  //     return;
  //   }

  //   const callType = this.normalizeCallType(payload.callType);

  //   console.log(`[CALL BUSY:${callType}] ${busyUserId} -> ${callerId}`);

  //   this.server.to(this.getUserRoom(callerId)).emit('callBusy', {
  //     targetUserId: busyUserId,
  //     reason: 'user_in_call',
  //     callType,
  //   });
  // }

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

    const callType = this.normalizeCallType(payload.callType);

    console.log(`[CALL REJECTED:${callType}] ${rejecterId} -> ${callerId}`);

    const partner = this.getPartner(rejecterId);
    if (partner) {
      this.clearCallPair(rejecterId, partner);
      this.clearCallPair(partner, rejecterId);
    }

    this.clearCallPair(rejecterId, callerId);
    this.clearCallPair(callerId, rejecterId);

    this.server.to(this.getUserRoom(callerId)).emit('callRejected', {
      by: rejecterId,
      callType,
    });

    // Dismiss IncomingCallScreen on other devices of the rejecter
    socket.to(this.getUserRoom(rejecterId)).emit('callAnsweredElsewhere', {
      callerId,
      callType,
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

    const callType = this.normalizeCallType(payload.callType);

    console.log(`[CALL ENDED:${callType}] ${userId} <-> ${otherUserId}`);

    const partner = this.getPartner(userId);

    if (partner) {
      this.clearCallPair(userId, partner);
    }

    this.clearCallPair(userId, otherUserId);
    this.clearCallPair(otherUserId, userId);

    this.server.to(this.getUserRoom(otherUserId)).emit('callEnded', {
      by: userId,
      callType,
    });

    if (partner && partner !== otherUserId) {
      this.server.to(this.getUserRoom(partner)).emit('callEnded', {
        by: userId,
        callType,
      });
    }
  }
}
