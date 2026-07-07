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
  isVideoCall?: boolean; // ADDED
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

// ADDED — payloads for the switch-to-video handshake + renegotiation
interface SwitchToVideoPayload {
  targetUserId: string;
}

interface RenegotiateOfferPayload {
  targetUserId: string;
  offer: any;
}

interface RenegotiateAnswerPayload {
  targetUserId: string;
  answer: any;
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

    const isVideoCall = !!payload.isVideoCall; // ADDED

    console.log(
      `[CALL] ${callerId} -> ${calleeId} (video=${isVideoCall})`, // CHANGED — logs call type
    );

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
      isVideoCall, // ADDED — lets the client show "Incoming video call…"
    });
    const sockets = await this.socketService.getUserConnections(calleeId);
    if (!sockets || sockets.length === 0) {
      console.log(
        `[CALL NOTIFICATION] ${calleeId} is offline, sending push notification`,
      );
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
            // offer: JSON.stringify(payload.offer),
            // ADDED — client's FCM background handler reads data.callType /
            // data.isVideoCall to decide whether to show a video-call push.
            callType: isVideoCall ? 'video' : 'audio',
            isVideoCall: isVideoCall ? '1' : '0',
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

  // ADDED — BUSY CALL: a device that's already in a call (or has a pending
  // call) tells the incoming caller it's busy, without ever having gone
  // through the isUserBusy() check in handleCallUser (e.g. the callee's
  // OTHER device is mid-call while this event was still in flight).
  @SubscribeMessage('busyCall')
  handleBusyCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const busyUserId = socket.handshake.query.subjectId as string;
    const callerId = String(payload.targetUserId);

    if (!busyUserId) {
      socket.emit('error', { message: 'User ID is required' });
      return;
    }

    console.log(`[CALL BUSY] ${busyUserId} is busy, notifying ${callerId}`);

    this.server.to(this.getUserRoom(callerId)).emit('callBusy', {
      targetUserId: busyUserId,
      reason: 'user_in_call',
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

  // ==========================
  // SWITCH-TO-VIDEO EVENTS (ADDED)
  // Mid-call upgrade from an audio call to video. All of these are simple
  // relays guarded by isActivePair() so only the two people actually on
  // the call can trigger them for each other.
  // ==========================

  @SubscribeMessage('switchToVideoRequest')
  handleSwitchToVideoRequest(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SwitchToVideoPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    console.log(`[SWITCH-TO-VIDEO] request ${fromUserId} -> ${targetUserId}`);

    this.server
      .to(this.getUserRoom(targetUserId))
      .emit('switchToVideoRequest', { fromUserId });
  }

  @SubscribeMessage('switchToVideoAccepted')
  handleSwitchToVideoAccepted(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SwitchToVideoPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    console.log(`[SWITCH-TO-VIDEO] accepted ${fromUserId} -> ${targetUserId}`);

    this.server
      .to(this.getUserRoom(targetUserId))
      .emit('switchToVideoAccepted', { fromUserId });
  }

  @SubscribeMessage('switchToVideoDeclined')
  handleSwitchToVideoDeclined(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SwitchToVideoPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    console.log(`[SWITCH-TO-VIDEO] declined ${fromUserId} -> ${targetUserId}`);

    this.server
      .to(this.getUserRoom(targetUserId))
      .emit('switchToVideoDeclined', { fromUserId });
  }

  @SubscribeMessage('switchToVideoCancelled')
  handleSwitchToVideoCancelled(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SwitchToVideoPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    this.server
      .to(this.getUserRoom(targetUserId))
      .emit('switchToVideoCancelled', { fromUserId });
  }

  // ADDED — SDP renegotiation relay (adds the video m-line to an
  // already-connected audio call). Same shape as iceCandidate/callUser.
  @SubscribeMessage('renegotiateOffer')
  handleRenegotiateOffer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: RenegotiateOfferPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    console.log(`[RENEGOTIATE] offer ${fromUserId} -> ${targetUserId}`);

    this.server.to(this.getUserRoom(targetUserId)).emit('renegotiateOffer', {
      offer: payload.offer,
      fromUserId,
    });
  }

  @SubscribeMessage('renegotiateAnswer')
  handleRenegotiateAnswer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: RenegotiateAnswerPayload,
  ) {
    const fromUserId = socket.handshake.query.subjectId as string;
    const targetUserId = String(payload.targetUserId);

    if (!fromUserId || !this.isActivePair(fromUserId, targetUserId)) return;

    console.log(`[RENEGOTIATE] answer ${fromUserId} -> ${targetUserId}`);

    this.server.to(this.getUserRoom(targetUserId)).emit('renegotiateAnswer', {
      answer: payload.answer,
      fromUserId,
    });
  }
}
