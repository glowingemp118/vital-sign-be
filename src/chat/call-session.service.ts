import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

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
};

/** In-memory pending WebRTC offers for CallKit (fetch after Accept). */
@Injectable()
export class CallSessionService {
  private readonly sessions = new Map<string, PendingCall>();
  private readonly TTL_MS = 90_000;

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
