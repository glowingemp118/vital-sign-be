import { Injectable } from '@nestjs/common';
import { SocketConnection } from './schemas/socket.schema';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Server } from 'socket.io';
import { Connection } from 'mongoose';

type ConnectionType = 'direct' | 'group' | 'self';

interface RegisterSocketParams {
  subjectId: string;
  socketId: string;
  type?: ConnectionType;
  objectId?: string | null;
  conversationId?: string | null;
}

@Injectable()
export class SocketService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(SocketConnection.name)
    private socketConnectionModel: Model<SocketConnection>,
  ) {}

  private server: Server;

  setServer(server: Server) {
    this.server = server;
  }

  getUserRoom(userId: string): string {
    return `user_${userId}`;
  }

  getConversationRoom(conversationId: string): string {
    return `conversation_${conversationId}`;
  }

  /** Emit to a specific socket id */
  emitToSocket(socketId: string, event: string, payload: any) {
    if (!this.server || !socketId) return;
    this.server.to(socketId).emit(event, payload);
  }

  /** Emit to ALL sockets/devices of a user (user room) */
  emitToUser(userId: string, event: string, payload: any) {
    if (!this.server || !userId) return;
    this.server.to(this.getUserRoom(userId)).emit(event, payload);
  }

  /** Emit to everyone in a conversation room */
  emitToConversation(conversationId: string, event: string, payload: any) {
    if (!this.server || !conversationId) return;
    this.server.to(this.getConversationRoom(conversationId)).emit(event, payload);
  }

  /** Count registered sockets for a user (for debug + offline detection) */
  async countUserSockets(userId: string): Promise<number> {
    return this.socketConnectionModel.countDocuments({
      subjectId: new Types.ObjectId(userId),
    });
  }

  /**
   * Register one socket per device — never delete other devices for the same user.
   * Upsert keyed by socketId only.
   */
  async registerSocket({
    subjectId,
    socketId,
    type = 'self',
    objectId,
    conversationId,
  }: RegisterSocketParams) {
    let chatRoomId: string;

    if (type === 'self') {
      chatRoomId = this.getUserRoom(subjectId);
    } else if (type === 'group' && objectId) {
      chatRoomId = objectId;
    } else if (conversationId) {
      chatRoomId = this.getConversationRoom(conversationId);
    } else if (objectId) {
      chatRoomId = (this.socketConnectionModel as any).generateChatRoomId(
        subjectId,
        objectId,
      );
    } else {
      chatRoomId = this.getUserRoom(subjectId);
    }

    return this.socketConnectionModel.findOneAndUpdate(
      { socketId },
      {
        subjectId: new Types.ObjectId(subjectId),
        objectId: objectId ? new Types.ObjectId(objectId) : undefined,
        socketId,
        lastActive: new Date(),
        chatRoomId,
        type,
        ...(conversationId ? { conversationId } : {}),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );
  }

  /** @deprecated use registerSocket — kept for compatibility */
  async createOrUpdateConnection(params: RegisterSocketParams & { objectId?: string }) {
    return this.registerSocket(params);
  }

  async deleteConnectionByUserId(
    subjectId: string,
    objectId?: string,
    type: ConnectionType = 'direct',
  ) {
    const query: any = { subjectId: new Types.ObjectId(subjectId), type };
    if (objectId) query.objectId = new Types.ObjectId(objectId);
    await this.socketConnectionModel.deleteMany(query);
    return { message: 'Connections deleted successfully' };
  }

  async getUserConnections(subjectId: string) {
    return this.socketConnectionModel.find({
      subjectId: new Types.ObjectId(subjectId),
    });
  }

  async getConnectionByChatRoomId(subjectId: string, chatRoomId: string) {
    return this.socketConnectionModel.findOne({ subjectId, chatRoomId });
  }

  async getConnectionsByGroupId(groupId: string) {
    return this.socketConnectionModel.find({
      objectId: groupId,
      type: 'group',
    });
  }

  /** Remove only this socket — other devices stay registered */
  async deleteConnectionBySocketId(socketId: string) {
    return this.socketConnectionModel.deleteOne({ socketId });
  }

  async touchSocket(socketId: string) {
    return this.socketConnectionModel.updateOne(
      { socketId },
      { lastActive: new Date() },
    );
  }

  private inactiveConnectionInterval: NodeJS.Timeout;

  onModuleInit() {
    this.inactiveConnectionInterval = setInterval(
      () => this.removeInactiveConnections(),
      60000,
    );
  }

  onModuleDestroy() {
    clearInterval(this.inactiveConnectionInterval);
  }

  private async removeInactiveConnections() {
    if (this.connection.readyState !== 1) {
      console.warn('[Socket] MongoDB not connected — skipping inactive cleanup');
      return;
    }

    try {
      await (this.socketConnectionModel as any).removeInactiveConnections();
    } catch (err) {
      console.error('[Socket] inactive cleanup error', err);
    }
  }
}
