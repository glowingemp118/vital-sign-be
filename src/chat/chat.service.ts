import { Injectable } from '@nestjs/common';
import mongoose, { Model, Types } from 'mongoose';
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
import { Voice } from 'src/health-voice/schemas/voice.schema';
import { Transcription } from 'src/features/schemas/transcription.schema';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Message.name) private msgModel: Model<Message>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(SocketConnection.name)
    private socketConnectionModel: Model<SocketConnection>, // Inject SocketConnection model
    @InjectModel(Voice.name) private voiceModel: Model<Voice>,
    @InjectModel(Transcription.name)
    private transcriptionModel: Model<Transcription>,
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
            otherUser: processObject(ou, 'decrypt'),
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
        {
          $lookup: {
            from: 'voices',
            // localField: "voiceId",
            // foreignField: "_id",
            let: { voiceId: '$voiceId' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$voiceId'],
                  },
                },
              },
              {
                $addFields: {
                  'latestSummary.audioUrl': {
                    $concat: [
                      'https://res.cloudinary.com/',
                      process.env.CLOUDINARY_CLOUD_NAME,
                      '/video/upload/',
                      '$latestSummary.audioUrl',
                    ],
                  },
                },
              },
            ],
            as: 'voice',
          },
        },
        {
          $unwind: { path: '$voice', preserveNullAndEmptyArrays: true },
        },
        {
          $project: {
            voiceId: 0,
          },
        },
        { $sort: { createdAt: -1 } },
        paginationPipeline({ pageno, limit }),
      ];
      const data = await this.msgModel.aggregate(pipeline);
      const res = finalRes({ pageno, limit, data });
      const formattedRes = {
        ...res,
        data: res?.data.map((msg: any) => {
          const timesince = moment(msg.createdAt).tz(timezone).fromNow();
          const mdata = {
            ...msg,
            content: processValue(msg.content, 'decrypt'),
            timesince,
            isRead: msg.readBy && msg.readBy.includes(otherUserId),
          };
          ['updatedAt', '__v', 'status', 'readBy', 'type'].forEach(
            (field) => delete mdata[field],
          );
          return mdata;
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
      voiceId,
    } = req.body;

    const user = req.user;

    if (conversationType === 'group') return;

    if (otherUserId === userId) {
      throw new Error('Cannot send message to yourself');
    }

    try {
      const receiverId = otherUserId;
      const receiver = await this.userModel
        .findOne(
          { _id: receiverId, status: 'active' },
          'name email image user_type',
        )
        .lean();
      if (!receiver) {
        throw new Error('Receiver user not found');
      }

      if (user.user_type !== UserType.User && voiceId) {
        throw new Error('Only patient can send voice messages');
      }

      let isTranscriptionExist;

      if (voiceId) {
        let isVoiceExist = await this.voiceModel.findById(voiceId);

        if (!isVoiceExist) {
          throw new Error('Voice not found');
        }

        isTranscriptionExist = await this.transcriptionModel.findOne({
          voice: new mongoose.Types.ObjectId(voiceId),
        });

        if (!isTranscriptionExist) {
          if (receiver.user_type === UserType.Doctor) {
            const transcription = new this.transcriptionModel({
              doctor: new mongoose.Types.ObjectId(receiverId),
              voice: new mongoose.Types.ObjectId(voiceId),
              user: new mongoose.Types.ObjectId(userId),
            });

            await transcription.save();
          }
        }
      }

      // Online if ANY socket is registered for this user (web + mobile)
      const receiverSockets = await this.socketConnectionModel
        .find({
          subjectId: new mongoose.Types.ObjectId(receiverId),
        })
        .lean();

      const isOnline = receiverSockets.length > 0;

      // Push unless the receiver is actively viewing THIS chat.
      // Note: countDocuments returns a number — never use it as a socket doc
      // (that skipped every push while any socket was connected).
      const isViewingThisChat = receiverSockets.some(
        (s: any) =>
          s.type === 'direct' &&
          s.objectId?.toString() === userId.toString(),
      );
      const shouldSendPush = !isViewingThisChat;

      const conversationId = (
        this.socketConnectionModel as any
      ).generateChatRoomId(userId, receiverId);

      let message: any = await this.msgModel.create({
        subjectId: userId,
        objectId: receiverId,
        messageType,
        content: processValue(content, 'encrypt'),
        mediaUrl,
        type: 'direct',
        readBy: isOnline ? [userId, receiverId] : [userId],
        status: isOnline ? 'DELIVERED' : 'SENT',
        ...(user.user_type === UserType.User
          ? { voiceId: new Types.ObjectId(voiceId) }
          : {}),
      });

      message = await this.msgModel.findById(message._id).populate('voiceId');

      if (isTranscriptionExist) {
        await this.notificationService.sendNotification({
          userId: receiverId,
          title: `Voice message from ${user.name}`,
          message: user.name + ' sent you a voice message',
          type: 'voice',
          object: {
            messageId: message._id?.toString(),
            objectId: userId?.toString(),
            subjectId: receiverId?.toString(),
          },
        });
      }

      const localDate = moment().tz(timezone);

      const cloudBase = `http://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/`;

      const messageObject = {
        ...message.toObject(),
        content,

        voiceId: {
          ...message.voiceId,
          latestSummary: message.voiceId?.latestSummary
            ? {
                ...message.voiceId.latestSummary,
                audioUrl: message.voiceId.latestSummary.audioUrl
                  ? cloudBase + message.voiceId.latestSummary.audioUrl
                  : null,
              }
            : null,
        },

        timesince: localDate.fromNow(),
      };
      const bTasks = async () => {
        const sender = await this.userModel
          .findById(userId, 'name email image user_type')
          .lean();

        const receivedPayload = {
          subjectId: userId,
          objectId: receiverId,
          messageType,
          ...messageObject,
        };

        // Emit to ALL receiver devices (user room) + conversation room
        this.socketService.emitToUser(
          receiverId,
          'receivedMessage',
          receivedPayload,
        );
        this.socketService.emitToConversation(
          conversationId,
          'receivedMessage',
          receivedPayload,
        );

        if (isOnline) {
          const unReadCount = await this.msgModel.countDocuments({
            objectId: receiverId,
            subjectId: userId,
            readBy: { $ne: receiverId },
          });

          const chatUpdatedPayload = {
            message: messageObject,
            unreadCount: unReadCount,
            otherUser: {
              ...processObject(sender, 'decrypt'),
              image: sender?.image ? process.env.IB_URL + sender.image : null,
              isOnline: true,
            },
          };

          this.socketService.emitToUser(
            receiverId,
            'chatUpdated',
            chatUpdatedPayload,
          );
          this.socketService.emitToConversation(
            conversationId,
            'chatUpdated',
            chatUpdatedPayload,
          );
        }

        // Also notify sender's other devices (web + mobile sync)
        this.socketService.emitToUser(userId, 'chatUpdated', {
          message: messageObject,
          unreadCount: 0,
        });

        if (shouldSendPush) {
          const msg = NOTIFICATION_CONFIG[NOTIFICATION_TYPE.MESSAGE_NEW];
          const name = processValue(user.name, 'decrypt');
          console.log(
            `[Chat] push message → receiver=${receiverId} online=${isOnline} sockets=${receiverSockets.length}`,
          );
          await this.notificationService.sendNotification({
            userId: receiverId,
            title: `${name} messaged you`,
            message: content?.substring(0, 100),
            type: msg.type,
            object: {
              messageId: message._id?.toString(),
              objectId: userId?.toString(),
              subjectId: receiverId?.toString(),
            },
          });
        } else {
          console.log(
            `[Chat] skip push receiver=${receiverId} (viewing this chat)`,
          );
        }
      };
      // 🔹 If receiver is online → emit via socket
      await bTasks();
      return {
        message: 'Message sent successfully',
        data: messageObject,
      };
    } catch (error: any) {
      throw new Error(`Error sending direct message: ${error.message}`);
    }
  }

  async deleteChat(req: any, otherUserId: string) {
    const userId = req?.user?._id;

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
