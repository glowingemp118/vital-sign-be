import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class SocketConnection {
  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required: true,
  })
  subjectId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    refPath: 'type',
    required: false,
  })
  objectId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['direct', 'group'],
    default: 'direct',
    required: true,
  })
  type: string;

  @Prop({
    type: String,
    required: true,
  })
  socketId: string;

  @Prop({
    type: String,
    required: true,
  })
  chatRoomId: string;

  @Prop({
    type: Date,
    default: Date.now,
  })
  lastActive: Date;
}
export type SocketConnectionDocument = SocketConnection & Document;
export const SocketConnectionSchema =
  SchemaFactory.createForClass(SocketConnection);

SocketConnectionSchema.statics.generateChatRoomId = function (
  subjectId: Types.ObjectId,
  objectId: Types.ObjectId,
): string {
  return [subjectId.toString(), objectId?.toString() || ''].sort().join('_');
};

SocketConnectionSchema.statics.removeInactiveConnections =
  async function (): Promise<void> {
    const timeMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    try {
      const result = await this.deleteMany({
        lastActive: { $lt: timeMinutesAgo },
      });
      console.log(
        `Cleaned up ${result.deletedCount} inactive socket connections`,
      );
    } catch (error) {
      console.error('Error cleaning up inactive socket connections:', error);
    }
  };
