import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { SocketService } from './socket.services';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly socketService: SocketService) {}
  @WebSocketServer() server: Server;
  afterInit() {
    // 👇 PASS IT TO SERVICE
    this.socketService.setServer(this.server);
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

    const connectionType = type === 'group' ? 'group' : 'direct';
    console.log(`Connection type determined: ${connectionType}`);

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

    await this.socketService.deleteConnectionByUserId(
      subjectIdString,
      connectionType === 'group' ? objectIdString || null : null,
      connectionType,
    );

    console.log(
      `User ${subjectIdString} removed from ${connectionType} active connections.`,
    );
  }
}
