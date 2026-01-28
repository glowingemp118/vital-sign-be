import { Injectable } from '@nestjs/common';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Message } from './schemas/message.schema';
import moment from 'moment';
import { SocketConnection } from './schemas/socket.schema';
import { User } from 'src/user/schemas/user.schema';
import { SocketService } from './socket.services';
import { chatPipeline, finalRes, paginationPipeline } from 'src/utils/dbUtils';
import { processObject, processValue } from 'src/utils/encrptdecrpt';
import { UserType } from 'src/user/dto/user.dto';
import { NotificationService } from 'src/notification/notification.service';
import {
  NOTIFICATION_CONFIG,
  NOTIFICATION_TYPE,
} from 'src/constants/constants';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Message.name) private msgModel: Model<Message>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(SocketConnection.name)
    private socketConnectionModel: Model<SocketConnection>, // Inject SocketConnection model
    private readonly socketService: SocketService,
    private readonly notificationService: NotificationService,
  ) {}

  // Fetch chats (first message from each conversation with users list)
  async fetchChats(req: any): Promise<any> {
    const { _id: userId, user_type, timezone = 'UTC' } = req.user;
    let { pageno, limit, search } = req.query || {};

    try {
      if (search && user_type !== UserType.User) {
        search = processValue(search || '', 'hash');
      }
      const pipeline: any[] = chatPipeline(userId, search);

      if (pageno && limit) {
        pipeline.push(paginationPipeline({ pageno, limit }));
      }

      const data: any = await this.msgModel.aggregate(pipeline);
      const res = finalRes({ pageno, limit, data });
      const formattedRes = {
        ...res,
        data: res?.data?.map((r: any) => {
          const ou = r.otherUser;
          const msg = r.message;
          return {
            ...r,
            otherUser:
              ou?.user_type == UserType.User
                ? processObject(ou, 'decrypt')
                : ou,
            message: {
              ...msg,
              content: processValue(msg.content, 'decrypt'),
              timesince: moment(msg.createdAt).tz(timezone).fromNow(),
            },
          };
        }),
      };

      return { message: 'fetch chats successfully', data: formattedRes };
    } catch (err) {
      throw new Error(err?.message || 'Error fetching chats');
    }
  }

  // Fetch messages (pagination)
  async fetchMessages(req: any, otherUserId: string) {
    const { _id: userId, timezone = 'UTC' } = req.user;
    const { pageno = 1, limit = 20 } = req.query;
    try {
      const ouser = await this.userModel.findById(otherUserId);
      if (!ouser) {
        throw new Error('Other user not found');
      }
      const query = {
        $or: [
          { subjectId: userId, objectId: otherUserId },
          { subjectId: otherUserId, objectId: userId },
        ],
      };
      await this.msgModel.updateMany(
        {
          objectId: userId,
          subjectId: otherUserId,
          readBy: { $ne: userId },
        },
        { $addToSet: { readBy: userId } },
      );
      const pipeline: any[] = [
        { $match: query },
        { $sort: { createdAt: -1 } },
        paginationPipeline({ pageno, limit }),
      ];
      const data = await this.msgModel.aggregate(pipeline);
      const res = finalRes({ pageno, limit, data });
      const formattedRes = {
        ...res,
        data: res?.data.map((msg: any) => {
          ['updatedAt', '__v', 'status', 'readBy', 'type'].forEach(
            (field) => delete msg[field],
          );
          const timesince = moment(msg.createdAt).tz(timezone).fromNow();
          return {
            ...msg,
            content: processValue(msg.content, 'decrypt'),
            timesince,
            isRead: msg.readBy && msg.readBy.includes(userId),
          };
        }),
      };

      return { message: 'fetch messages successfully', data: formattedRes };
    } catch (error) {
      throw new Error('Error fetching messages: ' + error.message);
    }
  }

  // Send a new direct (1-to-1) message
  async sendDirectMessage(req: any, otherUserId: string) {
    const { _id: userId, timezone = 'UTC' } = req.user;
    const {
      messageType = 'text',
      content,
      mediaUrl,
      conversationType = 'direct',
    } = req.body;

    if (conversationType === 'group') {
      // Call method to handle group message (not shown here)
      return;
    }

    try {
      const objectId = otherUserId; // Receiver ID

      if (objectId == userId) {
        throw new Error('Cannot send message to yourself');
      }
      const chatRoomId = (this.socketConnectionModel as any).generateChatRoomId(
        userId,
        objectId,
      );
      const rconnection = await this.socketConnectionModel.findOne({
        subjectId: objectId,
        objectId: userId,
        type: 'direct',
      });
      const readBy = rconnection ? [userId, objectId] : [userId];

      const message: any = await this.msgModel.create({
        subjectId: userId,
        objectId: objectId,
        messageType,
        content: processValue(content, 'encrypt'),
        mediaUrl,
        type: 'direct',
        readBy,
        status: rconnection ? 'DELIVERED' : 'SENT',
      });

      const localDate = moment(message.createdAt).tz(timezone).format();
      const messageObject = {
        ...message.toObject(),
        timesince: moment(localDate).fromNow(),
      };
      const btasks = async () => {
        try {
          this.socketService.emitToSocket(
            rconnection.socketId,
            'receivedMessage',
            messageObject,
          );
          this.socketService.emitToSocket(
            rconnection.socketId,
            'chatUpdated',
            messageObject,
          );
          await this.socketConnectionModel.updateOne(
            { _id: rconnection._id },
            { lastActive: Date.now() },
          );
        } catch (error) {
          console.error('Error in background task for sending message:', error);
        }
      };
      if (rconnection) {
        btasks();
      } else {
        const msg = NOTIFICATION_CONFIG[NOTIFICATION_TYPE.MESSAGE_NEW];
        await this.notificationService.sendNotification({
          userId: objectId,
          title: msg.title,
          message: content?.substring(0, 100),
          type: msg.type,
          object: { messageId: message._id, objectId, subjectId: userId },
        });
      }
      return {
        message: 'Message sent successfully',
        data: { ...messageObject, content },
      };
      // throw new Error('No active connection found for the recipient');
    } catch (error) {
      throw new Error('Error sending direct message: ' + error.message);
    }
  }

  async deleteChat(req: any, otherUserId: string) {
    const userId = req.user._id;

    try {
      const query = {
        $or: [
          { subjectId: userId, objectId: otherUserId },
          { subjectId: otherUserId, objectId: userId },
        ],
      };

      const result = await this.msgModel.deleteMany(query);

      if (result.deletedCount === 0) {
        throw new Error('No chat found to delete');
      }

      return {
        message: 'Chat deleted successfully',
        deletedCount: result.deletedCount,
      };
    } catch (error) {
      throw new Error('Error deleting chat: ' + error.message);
    }
  }

  async deleteMessage(req: any, messageId: string) {
    try {
      const message = await this.msgModel.findByIdAndDelete(messageId);

      if (!message) {
        throw new Error('No such message found');
      }

      return {
        message: 'Message deleted successfully',
        messageId,
      };
    } catch (error) {
      throw new Error('Error deleting message: ' + error.message);
    }
  }

  async markAllMessagesAsRead(req: any, otherUserId: string) {
    const userId = req.user._id;

    try {
      const result = await this.msgModel.updateMany(
        {
          $or: [
            { subjectId: otherUserId, objectId: userId },
            { subjectId: userId, objectId: otherUserId },
          ],
          readBy: { $ne: userId },
        },
        { $addToSet: { readBy: userId } },
      );

      if (result.modifiedCount === 0) {
        return {
          message: 'No unread messages found to mark as read',
          modifiedCount: 0,
        };
      }

      return {
        message: 'All messages marked as read successfully',
        modifiedCount: result.modifiedCount,
      };
    } catch (error) {
      throw new Error('Error marking messages as read: ' + error.message);
    }
  }
}
