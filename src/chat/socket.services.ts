// socket.service.ts
import { Injectable } from '@nestjs/common';
import { SocketConnection } from './schemas/socket.schema';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import { Connection } from 'mongoose';
type ConnectionType = 'direct' | 'group' | 'self';

interface CreateOrUpdateConnectionParams {
  subjectId: string;
  objectId: string;
  socketId: string;
  type?: ConnectionType;
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

  // 🔥 Emit to specific socket
  emitToSocket(socketId: string, event: string, payload: any) {
    if (!this.server || !socketId) return;
    this.server.to(socketId).emit(event, payload);
  }

  // ✅ Create or update connection (objectId optional)
  async createOrUpdateConnection({
    subjectId,
    objectId,
    socketId,
    type = 'direct',
  }: CreateOrUpdateConnectionParams & { objectId?: string }) {
    let chatRoomId: string | undefined;

    if (type === 'direct') {
      if (!objectId) {
        throw new Error('objectId is required for direct connection');
      }

      chatRoomId = (this.socketConnectionModel as any).generateChatRoomId(
        subjectId,
        objectId,
      );
    }

    if (type === 'group') {
      if (!objectId) {
        throw new Error('objectId is required for group connection');
      }
      chatRoomId = objectId;
    }

    // ✅ IMPORTANT: make query truly unique
    const query: any = {
      subjectId,
      type,
      ...(chatRoomId && { chatRoomId }),
    };

    const update = {
      subjectId,
      objectId,
      socketId,
      lastActive: new Date(),
      chatRoomId,
      type,
    };

    return this.socketConnectionModel.findOneAndUpdate(query, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  }

  // ✅ Delete connection (objectId optional)
  async deleteConnectionByUserId(
    subjectId: string,
    objectId?: string,
    type: ConnectionType = 'direct',
  ) {
    const query: any = { subjectId, type };
    if (objectId) query.objectId = objectId;

    await this.socketConnectionModel.deleteMany(query);
    return { message: 'Connections deleted successfully' };
  }

  // Retrieve by chatRoomId
  async getConnectionByChatRoomId(subjectId: string, chatRoomId: string) {
    return this.socketConnectionModel.findOne({ subjectId, chatRoomId });
  }

  // Retrieve group connections
  async getConnectionsByGroupId(groupId: string) {
    return this.socketConnectionModel.find({
      objectId: groupId,
      type: 'group',
    });
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
      console.warn('MongoDB not connected');
      return;
    }

    try {
      await (this.socketConnectionModel as any).removeInactiveConnections();
    } catch (err) {
      console.error(err);
    }
  }
}
