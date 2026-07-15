import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

export type BufferedIceCandidate = {
  candidate: any;
  fromUserId: string;
  toUserId: string;
  bufferedAt: number;
};

export type PendingCall = {
  uuid: string;
  callerId: string;
  calleeId: string;
  callType: 'audio' | 'video';
  offer: any;
  callerName: string;
  callerAvatar: string;
  createdAt: number;
  expiresAt: number;
  answered: boolean;
  /** ICE from either side while the peer was offline / not ready */
  pendingIce: BufferedIceCandidate[];
};

/** In-memory pending WebRTC offers + ICE for CallKit / FCM wake. */
@Injectable()
export class CallSessionService {
  private readonly sessions = new Map<string, PendingCall>();
  private readonly TTL_MS = 90_000;
  private readonly POST_ANSWER_TTL_MS = 120_000;
  private readonly MAX_ICE_PER_CALL = 120;

  create(params: {
    callerId: string;
    calleeId: string;
    callType: 'audio' | 'video';
    offer: any;
    callerName: string;
    callerAvatar: string;
    uuid?: string;
  }): PendingCall {
    this.cleanup();
    const uuid =
      params.uuid &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        params.uuid,
      )
        ? params.uuid
        : randomUUID();
    const now = Date.now();
    const { uuid: _ignore, ...rest } = params;
    const session: PendingCall = {
      uuid,
      ...rest,
      createdAt: now,
      expiresAt: now + this.TTL_MS,
      answered: false,
      pendingIce: [],
    };
    this.sessions.set(uuid, session);
    return session;
  }

  get(uuid: string): PendingCall | null {
    this.cleanup();
    const session = this.sessions.get(uuid);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(uuid);
      return null;
    }
    return session;
  }

  getOffer(uuid: string): PendingCall | null {
    return this.get(uuid);
  }

  markAnswered(callerId: string, calleeId: string): PendingCall | null {
    const session = this.findActiveForPair(callerId, calleeId);
    if (!session) return null;
    session.answered = true;
    session.expiresAt = Date.now() + this.POST_ANSWER_TTL_MS;
    return session;
  }

  findActiveForCallee(calleeId: string): PendingCall | null {
    this.cleanup();
    const id = String(calleeId || '').trim();
    if (!id) return null;

    let latest: PendingCall | null = null;
    for (const session of this.sessions.values()) {
      if (session.calleeId !== id) continue;
      if (session.expiresAt < Date.now()) continue;
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
    return latest;
  }

  findActiveForUser(userId: string): PendingCall | null {
    this.cleanup();
    const id = String(userId || '').trim();
    if (!id) return null;

    let latest: PendingCall | null = null;
    for (const session of this.sessions.values()) {
      if (session.expiresAt < Date.now()) continue;
      if (session.callerId !== id && session.calleeId !== id) continue;
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
    return latest;
  }

  findActiveForPair(userA: string, userB: string): PendingCall | null {
    this.cleanup();
    const a = String(userA || '').trim();
    const b = String(userB || '').trim();
    if (!a || !b) return null;

    let latest: PendingCall | null = null;
    for (const session of this.sessions.values()) {
      if (session.expiresAt < Date.now()) continue;
      const match =
        (session.callerId === a && session.calleeId === b) ||
        (session.callerId === b && session.calleeId === a);
      if (!match) continue;
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
    return latest;
  }

  bufferIceCandidate(params: {
    fromUserId: string;
    toUserId: string;
    candidate: any;
  }): { buffered: boolean; uuid?: string; queued?: number } {
    const session = this.findActiveForPair(params.fromUserId, params.toUserId);
    if (!session) {
      return { buffered: false };
    }

    if (!Array.isArray(session.pendingIce)) {
      session.pendingIce = [];
    }

    if (session.pendingIce.length >= this.MAX_ICE_PER_CALL) {
      session.pendingIce.shift();
    }

    session.pendingIce.push({
      candidate: params.candidate,
      fromUserId: String(params.fromUserId),
      toUserId: String(params.toUserId),
      bufferedAt: Date.now(),
    });

    session.expiresAt = Math.max(
      session.expiresAt,
      Date.now() + (session.answered ? this.POST_ANSWER_TTL_MS : this.TTL_MS),
    );

    return {
      buffered: true,
      uuid: session.uuid,
      queued: session.pendingIce.length,
    };
  }

  /** Read ICE for user without removing (for embedding in incomingCall). */
  peekIceFor(toUserId: string, uuid?: string): BufferedIceCandidate[] {
    const id = String(toUserId || '').trim();
    const session = uuid ? this.get(uuid) : this.findActiveForUser(id);
    if (!session?.pendingIce?.length) return [];
    return session.pendingIce.filter((item) => item.toUserId === id);
  }

  /** Drain buffered ICE meant for `toUserId`. */
  drainIceFor(toUserId: string, uuid?: string): BufferedIceCandidate[] {
    const id = String(toUserId || '').trim();
    const session = uuid ? this.get(uuid) : this.findActiveForUser(id);
    if (!session?.pendingIce?.length) return [];

    const keep: BufferedIceCandidate[] = [];
    const flush: BufferedIceCandidate[] = [];
    for (const item of session.pendingIce) {
      if (item.toUserId === id) {
        flush.push(item);
      } else {
        keep.push(item);
      }
    }
    session.pendingIce = keep;
    return flush;
  }

  delete(uuid: string) {
    this.sessions.delete(uuid);
  }

  deleteByPair(callerId: string, calleeId: string) {
    for (const [uuid, s] of this.sessions) {
      if (
        (s.callerId === callerId && s.calleeId === calleeId) ||
        (s.callerId === calleeId && s.calleeId === callerId)
      ) {
        this.sessions.delete(uuid);
      }
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [uuid, s] of this.sessions) {
      if (s.expiresAt < now) this.sessions.delete(uuid);
    }
  }
}
