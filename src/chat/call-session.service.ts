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
  /** ICE from either side while the peer had no live socket */
  pendingIce: BufferedIceCandidate[];
};

/** In-memory pending WebRTC offers + ICE for CallKit / FCM wake. */
@Injectable()
export class CallSessionService {
  private readonly sessions = new Map<string, PendingCall>();
  private readonly TTL_MS = 90_000;
  private readonly MAX_ICE_PER_CALL = 80;

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

  /** Return offer without deleting (caller may reconnect). */
  getOffer(uuid: string): PendingCall | null {
    return this.get(uuid);
  }

  /** Latest non-expired ringing session for this callee (FCM wake → socket reconnect). */
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

  /** Active session where user is caller or callee (for ICE buffer/flush). */
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

  /**
   * Queue ICE for a peer who is currently offline.
   * Returns true if buffered onto an active call session.
   */
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

    // Keep ringing session alive while ICE is still flowing
    session.expiresAt = Math.max(session.expiresAt, Date.now() + this.TTL_MS);

    return {
      buffered: true,
      uuid: session.uuid,
      queued: session.pendingIce.length,
    };
  }

  /** Drain buffered ICE meant for `toUserId`; leave the rest. */
  drainIceFor(toUserId: string, uuid?: string): BufferedIceCandidate[] {
    const id = String(toUserId || '').trim();
    const session = uuid
      ? this.get(uuid)
      : this.findActiveForUser(id);
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
