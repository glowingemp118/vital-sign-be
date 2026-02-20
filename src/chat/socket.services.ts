// socket.service.ts
import { Injectable } from '@nestjs/common';
import { SocketConnection } from './schemas/socket.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
type ConnectionType = 'direct' | 'group';

interface CreateOrUpdateConnectionParams {
  subjectId: string;
  objectId: string;
  socketId: string;
  type?: ConnectionType;
}

@Injectable()
export class SocketService {
  constructor(
    @InjectModel(SocketConnection.name)
    private socketConnectionModel: Model<SocketConnection>,
  ) {}

  private server: Server;
  setServer(server: Server) {
    this.server = server;
  }

  // 🔥 EMIT TO SPECIFIC SOCKET
  emitToSocket(socketId: string, event: string, payload: any) {
    if (!this.server) return;
    this.server.to(socketId).emit(event, payload);
  }
  // Create or update a connection (direct or group)
  async createOrUpdateConnection({
    subjectId,
    objectId,
    socketId,
    type = 'direct',
  }: CreateOrUpdateConnectionParams) {
    let chatRoomId: string | undefined;
    if (type === 'direct') {
      // Generate chatRoomId for direct (1-to-1) chat
      // Use the static method from the schema, not from the model instance
      // @ts-ignore
      chatRoomId = (this.socketConnectionModel as any).generateChatRoomId(
        subjectId,
        objectId,
      );
    } else if (type === 'group') {
      // Use groupId as chatRoomId
      chatRoomId = objectId;
    }

    const query = { subjectId, objectId, type };
    const update = {
      socketId,
      lastActive: Date.now(),
      chatRoomId,
    };
    const options = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    };

    return this.socketConnectionModel.findOneAndUpdate(query, update, options);
  }

  // Delete a connection by user ID (optionally by group and type)
  async deleteConnectionByUserId(
    subjectId: string,
    objectId: string | null = null,
    type: ConnectionType = 'direct',
  ) {
    const query: {
      subjectId: string;
      type: ConnectionType;
      objectId?: string;
    } = { subjectId, type };

    if (objectId) query.objectId = objectId;
    await this.socketConnectionModel.deleteMany(query);
    return { message: 'Connections deleted successfully' };
  }

  // Retrieve connection by chatRoomId
  async getConnectionByChatRoomId(objectId: string, chatRoomId: string) {
    return this.socketConnectionModel.findOne({
      subjectId: objectId, // receiverId
      chatRoomId,
    });
  }

  // Retrieve all connections for a group
  async getConnectionsByGroupId(objectId: string) {
    return this.socketConnectionModel.find({
      objectId,
      type: 'group',
    });
  }

  private inactiveConnectionInterval: NodeJS.Timeout;

  onModuleInit() {
    this.inactiveConnectionInterval = setInterval(
      () => this.removeInactiveConnections(),
      60000, // 1 minute
    );
  }

  onModuleDestroy() {
    if (this.inactiveConnectionInterval) {
      clearInterval(this.inactiveConnectionInterval);
    }
  }

  private async removeInactiveConnections() {
    try {
      await (this.socketConnectionModel as any).removeInactiveConnections();
    } catch (error) {
      console.error('Error removing inactive connections:', error);
    }
  }
}
