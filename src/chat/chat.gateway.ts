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
import { verify } from 'jsonwebtoken';
import { SocketService } from './socket.services';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from 'src/user/schemas/user.schema';
import { NotificationService } from 'src/notification/notification.service';
import { processValue } from '../utils/encrptdecrpt';
import { CallSessionService } from './call-session.service';
import { UserType } from 'src/user/dto/user.dto';

type CallType = 'audio' | 'video';

interface CallUserPayload {
  targetUserId: string;
  offer: any;
  callType?: CallType;
  uuid?: string;
  callUUID?: string;
}

interface AnswerCallPayload {
  targetUserId: string;
  answer: any;
  callType?: CallType;
  uuid?: string;
  callUUID?: string;
}

interface IceCandidatePayload {
  targetUserId: string;
  candidate: any;
}

interface CallActionPayload {
  targetUserId: string;
  callType?: CallType;
}

const JWT_SECRET = process.env.JWT_SECRET || 'Some Complex Secrete Value';

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly socketService: SocketService,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly notificationService: NotificationService,
    private readonly callSessionService: CallSessionService,
  ) {}

  @WebSocketServer() server!: Server;

  private activeCallMap = new Map<string, string>();
  /** In-memory registry — instant, no Mongo lag (source of truth for call routing) */
  private liveSocketsByUser = new Map<string, Set<string>>();
  /** Don't kill WebRTC on brief mobile socket blips during ICE connect */
  private disconnectGraceTimers = new Map<string, NodeJS.Timeout>();
  private readonly DISCONNECT_GRACE_MS = 20_000;

  afterInit() {
    this.socketService.setServer(this.server);
  }

  private trackSocket(userId: string, socketId: string) {
    if (!this.liveSocketsByUser.has(userId)) {
      this.liveSocketsByUser.set(userId, new Set());
    }
    this.liveSocketsByUser.get(userId)!.add(socketId);
  }

  private untrackSocket(userId: string, socketId: string) {
    this.liveSocketsByUser.get(userId)?.delete(socketId);
    if (this.liveSocketsByUser.get(userId)?.size === 0) {
      this.liveSocketsByUser.delete(userId);
    }
  }

  private getLiveSocketIds(userId: string): string[] {
    return [...(this.liveSocketsByUser.get(userId) || [])];
  }

  /** Live Socket.io room members (most reliable for emit) */
  private async getRoomSocketIds(userId: string): Promise<string[]> {
    const room = this.socketService.getUserRoom(userId);
    const sockets = await this.server.in(room).fetchSockets();
    return sockets.map((s) => s.id);
  }

  /** Emit to every live socket for a user — room + direct socketId */
  private async emitToUserLive(
    userId: string,
    event: string,
    payload: any,
  ): Promise<{ emitted: boolean; socketIds: string[] }> {
    const roomIds = await this.getRoomSocketIds(userId);
    const memoryIds = this.getLiveSocketIds(userId);
    const allIds = [...new Set([...roomIds, ...memoryIds])];

    // Room broadcast (covers all joined sockets)
    this.socketService.emitToUser(userId, event, payload);

    // Direct emit per socket (belt-and-suspenders)
    for (const socketId of allIds) {
      this.socketService.emitToSocket(socketId, event, payload);
    }

    return { emitted: allIds.length > 0, socketIds: allIds };
  }

  private normalizeCallType(callType?: string): CallType {
    return callType === 'video' ? 'video' : 'audio';
  }

  /** Resolve user id from auth.token, auth.subjectId, or query.subjectId */
  private resolveSubjectId(socket: Socket): string | null {
    const auth = (socket.handshake.auth || {}) as Record<string, string>;
    const query = socket.handshake.query;

    if (auth.token) {
      try {
        const payload: any = verify(auth.token, JWT_SECRET);
        if (payload?._id) return String(payload._id);
      } catch {
        // fall through to subjectId fields
      }
    }

    if (auth.subjectId) return String(auth.subjectId);

    const raw = query.subjectId;
    const fromQuery = Array.isArray(raw) ? raw[0] : raw;
    return fromQuery ? String(fromQuery) : null;
  }

  private getSubjectId(socket: Socket): string {
    return (
      (socket.data?.subjectId as string) || this.resolveSubjectId(socket) || ''
    );
  }

  private setCallPair(a: string, b: string) {
    this.activeCallMap.set(String(a), String(b));
    this.activeCallMap.set(String(b), String(a));
  }

  private clearCallPair(a: string, b: string) {
    this.activeCallMap.delete(String(a));
    this.activeCallMap.delete(String(b));
  }

  private getPartner(userId: string): string | null {
    return this.activeCallMap.get(String(userId)) || null;
  }

  private isUserBusy(userId: string): boolean {
    return !!this.activeCallMap.get(String(userId));
  }

  /** Connected call OR ringing/pending session counts as busy */
  private isInAnyCall(userId: string): boolean {
    return (
      this.isUserBusy(userId) ||
      this.callSessionService.isUserInActiveCall(userId)
    );
  }

  private async getCallRoleLabel(
    userId: string,
  ): Promise<'doctor' | 'patient'> {
    const user = await this.userModel
      .findById(userId)
      .select('user_type')
      .lean();
    return user?.user_type === UserType.Doctor ? 'doctor' : 'patient';
  }

  private async buildBusyPayload(
    busyUserId: string,
    callType: CallType,
    reason: 'caller_busy' | 'callee_busy' | 'user_in_call' = 'user_in_call',
  ) {
    const role = await this.getCallRoleLabel(busyUserId);
    const message =
      reason === 'caller_busy'
        ? 'You are already on another call'
        : role === 'doctor'
          ? 'The doctor is already on another call'
          : 'The patient is already on another call';

    return {
      targetUserId: busyUserId,
      reason,
      role,
      message,
      callType,
    };
  }

  private async emitToUserExcept(
    userId: string,
    exceptSocketId: string,
    event: string,
    payload: any,
  ) {
    const roomIds = await this.getRoomSocketIds(userId);
    const memoryIds = this.getLiveSocketIds(userId);
    const allIds = [...new Set([...roomIds, ...memoryIds])].filter(
      (id) => id !== exceptSocketId,
    );

    for (const socketId of allIds) {
      this.socketService.emitToSocket(socketId, event, payload);
    }

    return { emitted: allIds.length > 0, socketIds: allIds };
  }

  private getFullImageUrl(imageName: string | undefined): string {
    if (!imageName || imageName === 'noimage.png') return '';
    return `${process.env.IB_URL || ''}${imageName}`;
  }

  /** Deliver previously buffered ICE to a newly connected socket. */
  private flushBufferedIceToSocket(
    userId: string,
    socket: Socket,
    uuid?: string,
  ): number {
    const items = this.callSessionService.drainIceFor(userId, uuid);
    for (const item of items) {
      socket.emit('iceCandidate', {
        candidate: item.candidate,
        fromUserId: item.fromUserId,
      });
    }
    return items.length;
  }

  /** true if user currently has at least one live socket in memory or room */
  private async isUserReachable(userId: string): Promise<boolean> {
    if (this.getLiveSocketIds(userId).length > 0) return true;
    const roomIds = await this.getRoomSocketIds(userId);
    return roomIds.length > 0;
  }

  async handleConnection(socket: Socket) {
    const subjectId = this.resolveSubjectId(socket);
    const objectId = socket.handshake.query.objectId as string | undefined;

    if (!subjectId || !Types.ObjectId.isValid(subjectId)) {
      socket.emit('error', {
        message:
          'subjectId must be provided (query or auth) and must be a valid ObjectId.',
      });
      socket.disconnect(true);
      return;
    }

    socket.data.subjectId = subjectId;
    socket.data.objectId = objectId;

    const userRoom = this.socketService.getUserRoom(subjectId);

    socket.join(userRoom);
    this.trackSocket(subjectId, socket.id);

    try {
      await this.socketService.registerSocket({
        subjectId,
        socketId: socket.id,
        type: objectId && Types.ObjectId.isValid(objectId) ? 'direct' : 'self',
        objectId:
          objectId && Types.ObjectId.isValid(objectId) ? objectId : subjectId,
      });

      console.log(
        `[Socket] connect subjectId=${subjectId} socketId=${socket.id} type=${
          objectId ? 'direct' : 'self'
        }`,
      );

      // Mobile often reconnects AFTER FCM wake (live was 0 during callUser).
      // Replay stored ringing offer + any ICE already buffered from the caller.
      const pending = this.callSessionService.findActiveForCallee(subjectId);
      if (pending) {
        const iceForCallee = this.callSessionService.peekIceFor(
          subjectId,
          pending.uuid,
        );
        console.log(
          `[Call] replay incomingCall on connect callee=${subjectId} uuid=${pending.uuid} caller=${pending.callerId} iceBuffered=${iceForCallee.length}`,
        );
        socket.emit('incomingCall', {
          callerId: pending.callerId,
          callerName: pending.callerName,
          callerAvatar: pending.callerAvatar,
          offer: pending.offer,
          callType: pending.callType,
          uuid: pending.uuid,
          callUUID: pending.uuid,
          // Embedded so mobile can apply AFTER setRemoteDescription(offer)
          iceCandidates: iceForCallee.map((i) => ({
            candidate: i.candidate,
            fromUserId: i.fromUserId,
          })),
        });

        // Also trickle after a short delay — PC may not exist at t=0
        const uuid = pending.uuid;
        const sock = socket;
        setTimeout(() => {
          if (!sock.connected) return;
          const flushed = this.flushBufferedIceToSocket(subjectId, sock, uuid);
          if (flushed > 0) {
            console.log(
              `[Call] delayed-flushed ${flushed} iceCandidate(s) to=${subjectId} uuid=${uuid}`,
            );
          }
        }, 1500);
      } else {
        // Caller (or in-call peer) reconnect: flush any ICE waiting for them
        const active = this.callSessionService.findActiveForUser(subjectId);
        const flushed = this.flushBufferedIceToSocket(
          subjectId,
          socket,
          active?.uuid,
        );
        if (flushed > 0) {
          console.log(
            `[Call] flushed ${flushed} buffered iceCandidate(s) on connect to=${subjectId} uuid=${active?.uuid || 'n/a'}`,
          );
        }
      }

      // Cancel pending "callEnded from disconnect" if they came back in time
      this.clearDisconnectGrace(subjectId);
    } catch (error) {
      console.error(`[Socket] register failed subjectId=${subjectId}`, error);
    }
  }

  async handleDisconnect(socket: Socket) {
    const subjectId = this.getSubjectId(socket);

    await this.socketService.deleteConnectionBySocketId(socket.id);
    this.untrackSocket(subjectId, socket.id);

    const remaining = this.getLiveSocketIds(subjectId).length;
    const dbRemaining = subjectId
      ? await this.socketService.countUserSockets(subjectId)
      : 0;
    console.log(
      `[Socket] disconnect subjectId=${subjectId} socketId=${socket.id} live=${remaining} db=${dbRemaining}`,
    );

    // Only end the call if they stay gone — mobile often blips during FCM/ICE setup
    const partnerId = this.getPartner(subjectId);
    if (partnerId && remaining === 0) {
      this.scheduleDisconnectGrace(subjectId, partnerId);
    }
  }

  private clearDisconnectGrace(userId: string) {
    const t = this.disconnectGraceTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this.disconnectGraceTimers.delete(userId);
    }
  }

  private scheduleDisconnectGrace(userId: string, partnerId: string) {
    this.clearDisconnectGrace(userId);
    const timer = setTimeout(() => {
      this.disconnectGraceTimers.delete(userId);
      // Still offline and still paired?
      if (this.getLiveSocketIds(userId).length > 0) return;
      if (this.getPartner(userId) !== partnerId) return;

      console.log(
        `[Call] disconnect grace expired — ending call user=${userId} partner=${partnerId}`,
      );
      this.clearCallPair(userId, partnerId);
      this.callSessionService.deleteByPair(userId, partnerId);
      this.socketService.emitToUser(partnerId, 'callEnded', {
        by: userId,
        reason: 'peer_disconnected',
      });
    }, this.DISCONNECT_GRACE_MS);
    this.disconnectGraceTimers.set(userId, timer);
  }

  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = this.getSubjectId(socket);
    if (!payload?.conversationId) return;

    socket.join(this.socketService.getConversationRoom(payload.conversationId));

    await this.socketService.registerSocket({
      subjectId: userId,
      socketId: socket.id,
      type: payload.conversationId !== userId ? 'direct' : 'self',
      objectId: payload.conversationId,
    });

    console.log(
      `[Chat] ${userId} joined conversation ${payload.conversationId}`,
    );
  }

  @SubscribeMessage('leaveConversation')
  async handleLeaveConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = this.getSubjectId(socket);
    if (!payload?.conversationId) return;

    socket.leave(
      this.socketService.getConversationRoom(payload.conversationId),
    );

    // Reset presence so message push is not stuck on "viewing this chat"
    await this.socketService.registerSocket({
      subjectId: userId,
      socketId: socket.id,
      type: 'self',
      objectId: userId,
    });

    console.log(`[Chat] ${userId} left conversation ${payload.conversationId}`);
  }

  // ==========================
  // CALL EVENTS (WebRTC signaling)
  // ==========================

  @SubscribeMessage('callUser')
  async handleCallUser(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallUserPayload,
  ) {
    const callerId = this.getSubjectId(socket);
    const calleeId = payload?.targetUserId
      ? String(payload.targetUserId).trim()
      : '';

    console.log(
      `[Call] 1. callUser received — from=${callerId} to=${calleeId} callerSocket=${socket.id}`,
    );

    if (!callerId) {
      socket.emit('error', { message: 'Caller ID is required' });
      return;
    }

    if (!calleeId) {
      socket.emit('error', { message: 'Target user ID is required' });
      return;
    }

    if (!payload.offer) {
      socket.emit('error', { message: 'WebRTC offer is required' });
      return;
    }

    const callType = this.normalizeCallType(payload.callType);

    if (this.isInAnyCall(callerId)) {
      const busy = await this.buildBusyPayload(
        callerId,
        callType,
        'caller_busy',
      );
      console.log(
        `[Call] busy — caller already in call caller=${callerId} callee=${calleeId}`,
      );
      socket.emit('callBusy', busy);
      return;
    }

    if (this.isInAnyCall(calleeId)) {
      const busy = await this.buildBusyPayload(
        calleeId,
        callType,
        'callee_busy',
      );
      console.log(
        `[Call] busy — callee already in call caller=${callerId} callee=${calleeId} role=${busy.role}`,
      );
      socket.emit('callBusy', busy);
      this.socketService.emitToUser(callerId, 'callBusy', busy);
      return;
    }

    const liveIds = this.getLiveSocketIds(calleeId);
    const roomIds = await this.getRoomSocketIds(calleeId);
    const dbCount = await this.socketService.countUserSockets(calleeId);
    const dbConnections = await this.socketService.getUserConnections(calleeId);
    const dbSocketIds = dbConnections.map((c) => c.socketId);

    console.log(
      `[Call] 2. sockets for targetUserId=${calleeId} — live=${liveIds.length} room=${roomIds.length} db=${dbCount}`,
    );
    console.log(
      `[Call]    liveIds=[${liveIds.join(', ')}] roomIds=[${roomIds.join(', ')}] dbIds=[${dbSocketIds.join(', ')}]`,
    );

    const caller = await this.userModel
      .findById(callerId)
      .select('name image')
      .lean();

    if (caller) {
      caller.name = processValue(caller?.name, 'decrypt');
    }

    const callerName = caller?.name || 'Unknown';
    const callerAvatar = this.getFullImageUrl(caller?.image) || '';

    // Store offer server-side (VoIP push must not carry full SDP)
    // Prefer mobile-provided uuid/callUUID when valid (CallKit pairing)
    const session = this.callSessionService.create({
      callerId,
      calleeId,
      callType,
      offer: payload.offer,
      callerName,
      callerAvatar,
      uuid: payload.uuid || payload.callUUID,
    });

    const incomingPayload = {
      callerId,
      callerName,
      callerAvatar,
      offer: payload.offer,
      callType,
      uuid: session.uuid,
      callUUID: session.uuid,
    };

    const { emitted, socketIds } = await this.emitToUserLive(
      calleeId,
      'incomingCall',
      incomingPayload,
    );

    console.log(
      `[Call] 3. incomingCall emitted=${emitted ? 'yes' : 'no'} to=${calleeId} socketIds=[${socketIds.join(', ')}] callType=${callType} uuid=${session.uuid}`,
    );

    // Always push for reliability (iOS VoIP when killed + Android FCM)
    try {
      const pushResult = await this.notificationService.sendIncomingCallPush({
        userId: calleeId,
        uuid: session.uuid,
        callerId,
        callerName,
        callerAvatar,
        callType,
      });
      console.log(
        `[Call] 4. push voipSent=${pushResult.voipSent} fcmSent=${pushResult.fcmSent} (voipTokens=${pushResult.voipTokens} fcmTokens=${pushResult.fcmTokens})`,
      );
    } catch (err: any) {
      console.error('[Call] push failed:', err?.message || err);
    }
  }

  @SubscribeMessage('answerCall')
  async handleAnswerCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: AnswerCallPayload,
  ) {
    const calleeId = this.getSubjectId(socket);
    const callerId = String(payload.targetUserId);
    const callType = this.normalizeCallType(payload.callType);
    const callUuid = payload.uuid || payload.callUUID;

    console.log(
      `[Call] answerCall from=${calleeId} to=${callerId} callType=${callType} uuid=${callUuid || 'n/a'} socket=${socket.id}`,
    );

    if (!calleeId) {
      socket.emit('error', { message: 'Callee ID is required' });
      return;
    }

    const session = callUuid
      ? this.callSessionService.get(String(callUuid))
      : this.callSessionService.findActiveForPair(callerId, calleeId);

    const alreadyPaired =
      this.getPartner(calleeId) === callerId ||
      this.getPartner(callerId) === calleeId;

    // Same call already accepted on another device (WhatsApp-style)
    if (session?.answered || alreadyPaired) {
      console.log(
        `[Call] answerCall blocked — already active elsewhere uuid=${session?.uuid || 'n/a'}`,
      );
      socket.emit('callAlreadyActive', {
        uuid: session?.uuid || callUuid || null,
        callerId,
        callType,
        message: 'This call is already active on another device',
      });
      return;
    }

    // Callee already in a different call
    const calleePartner = this.getPartner(calleeId);
    if (calleePartner && calleePartner !== callerId) {
      const busy = await this.buildBusyPayload(
        calleeId,
        callType,
        'caller_busy',
      );
      socket.emit('callBusy', busy);
      return;
    }

    // Caller already in a different call
    const callerPartner = this.getPartner(callerId);
    if (callerPartner && callerPartner !== calleeId) {
      const busy = await this.buildBusyPayload(
        callerId,
        callType,
        'callee_busy',
      );
      socket.emit('callBusy', busy);
      return;
    }

    // Ringing session exists for a different pair involving callee/caller
    const calleeRinging = this.callSessionService.findActiveForUser(calleeId);
    if (
      calleeRinging &&
      !(
        calleeRinging.callerId === callerId &&
        calleeRinging.calleeId === calleeId
      )
    ) {
      const busy = await this.buildBusyPayload(
        calleeId,
        callType,
        'caller_busy',
      );
      socket.emit('callBusy', busy);
      return;
    }

    this.setCallPair(callerId, calleeId);
    const answeredSession = this.callSessionService.markAnswered(
      callerId,
      calleeId,
      socket.id,
    );
    this.clearDisconnectGrace(calleeId);
    this.clearDisconnectGrace(callerId);

    const iceForCaller = this.callSessionService.peekIceFor(callerId);
    this.socketService.emitToUser(callerId, 'callAnswered', {
      answer: payload.answer,
      calleeId,
      callType,
      uuid: answeredSession?.uuid || callUuid || null,
      iceCandidates: iceForCaller.map((i) => ({
        candidate: i.candidate,
        fromUserId: i.fromUserId,
      })),
    });

    // Stop ringing / dismiss CallKit UI on all other devices for this account
    const elsewherePayload = {
      uuid: answeredSession?.uuid || callUuid || null,
      callerId,
      callType,
      message: 'Call answered on another device',
    };
    const { socketIds } = await this.emitToUserExcept(
      calleeId,
      socket.id,
      'callAnsweredElsewhere',
      elsewherePayload,
    );
    console.log(
      `[Call] callAnsweredElsewhere → otherDevices=${socketIds.length} uuid=${elsewherePayload.uuid}`,
    );

    // Deliver buffered ICE both ways (and keep copies peeked above for callers that apply from payload)
    const toCaller = this.callSessionService.drainIceFor(callerId);
    for (const item of toCaller) {
      this.socketService.emitToUser(callerId, 'iceCandidate', {
        candidate: item.candidate,
        fromUserId: item.fromUserId,
      });
    }
    const toCallee = this.callSessionService.drainIceFor(calleeId);
    for (const item of toCallee) {
      socket.emit('iceCandidate', {
        candidate: item.candidate,
        fromUserId: item.fromUserId,
      });
      this.socketService.emitToUser(calleeId, 'iceCandidate', {
        candidate: item.candidate,
        fromUserId: item.fromUserId,
      });
    }
    console.log(
      `[Call] answerCall ice → callerPayload=${iceForCaller.length} flushedCaller=${toCaller.length} flushedCallee=${toCallee.length}`,
    );
  }

  @SubscribeMessage('iceCandidate')
  async handleIceCandidate(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: IceCandidatePayload,
  ) {
    const fromUserId = this.getSubjectId(socket);
    const targetUserId = String(payload.targetUserId || '').trim();

    if (!fromUserId || !targetUserId || !payload.candidate) return;

    // Always buffer while a call session exists so reconnect/replay never loses ICE
    const buffered = this.callSessionService.bufferIceCandidate({
      fromUserId,
      toUserId: targetUserId,
      candidate: payload.candidate,
    });

    const reachable = await this.isUserReachable(targetUserId);
    if (reachable) {
      this.socketService.emitToUser(targetUserId, 'iceCandidate', {
        candidate: payload.candidate,
        fromUserId,
      });
    }

    console.log(
      `[Call] iceCandidate from=${fromUserId} to=${targetUserId} live=${reachable} buffered=${buffered.buffered} queued=${buffered.queued ?? 0}`,
    );
  }

  @SubscribeMessage('busyCall')
  async handleBusyCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const busyUserId = this.getSubjectId(socket);
    const callerId = String(payload.targetUserId);
    const callType = this.normalizeCallType(payload.callType);

    console.log(`[Call] busyCall from=${busyUserId} to=${callerId}`);

    const busy = await this.buildBusyPayload(
      busyUserId,
      callType,
      'callee_busy',
    );
    this.socketService.emitToUser(callerId, 'callBusy', busy);
  }

  @SubscribeMessage('rejectCall')
  async handleRejectCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const callerId = String(payload.targetUserId);
    const rejecterId = this.getSubjectId(socket);
    const callType = this.normalizeCallType(payload.callType);

    console.log(`[Call] rejectCall from=${rejecterId} to=${callerId}`);

    const partner = this.getPartner(rejecterId);
    if (partner) {
      this.clearCallPair(rejecterId, partner);
    }
    this.clearCallPair(rejecterId, callerId);
    this.clearCallPair(callerId, rejecterId);

    this.socketService.emitToUser(callerId, 'callRejected', {
      by: rejecterId,
      callType,
    });

    this.callSessionService.deleteByPair(rejecterId, callerId);

    // Stop ringing on other devices of the same account
    await this.emitToUserExcept(rejecterId, socket.id, 'callAnsweredElsewhere', {
      callerId,
      callType,
      message: 'Call dismissed on another device',
    });
  }

  @SubscribeMessage('endCall')
  handleEndCall(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: CallActionPayload,
  ) {
    const otherUserId = String(payload.targetUserId);
    const userId = this.getSubjectId(socket);
    const callType = this.normalizeCallType(payload.callType);

    console.log(`[Call] endCall from=${userId} to=${otherUserId}`);

    const partner = this.getPartner(userId);
    if (partner) {
      this.clearCallPair(userId, partner);
    }
    this.clearCallPair(userId, otherUserId);
    this.clearCallPair(otherUserId, userId);

    this.socketService.emitToUser(otherUserId, 'callEnded', {
      by: userId,
      callType,
    });

    this.callSessionService.deleteByPair(userId, otherUserId);

    if (partner && partner !== otherUserId) {
      this.socketService.emitToUser(partner, 'callEnded', {
        by: userId,
        callType,
      });
    }
  }
}
