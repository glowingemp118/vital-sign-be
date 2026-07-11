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
  objectId?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['direct', 'group', 'self'],
    default: 'self',
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
    type: String,
    required: false,
  })
  conversationId?: string;

  @Prop({
    type: Date,
    default: Date.now,
  })
  lastActive: Date;
}

export type SocketConnectionDocument = SocketConnection & Document;
export const SocketConnectionSchema =
  SchemaFactory.createForClass(SocketConnection);

SocketConnectionSchema.index({ subjectId: 1 });
SocketConnectionSchema.index({ socketId: 1 }, { unique: true });

SocketConnectionSchema.statics.generateChatRoomId = function (
  subjectId: Types.ObjectId | string,
  objectId: Types.ObjectId | string,
): string {
  return [subjectId.toString(), objectId?.toString() || ''].sort().join('_');
};

SocketConnectionSchema.statics.removeInactiveConnections = async function () {
  const timeMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  try {
    await this.deleteMany({
      lastActive: { $lt: timeMinutesAgo },
    });
  } catch (err) {
    console.error('[Socket] inactive cleanup failed', err);
  }
};
