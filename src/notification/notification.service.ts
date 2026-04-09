import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { RecordService } from 'src/features/services/records.services';
import { Device } from 'src/user/schemas/devices.schema';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import admin from '../config/firebase';
import { Notification } from './notification.schema';

@Injectable()
export class NotificationService {
  constructor(
    @InjectModel(Device.name) private readonly deviceModel: Model<Device>,
    @InjectModel(Notification.name) private readonly notificationModel: Model<Notification>, // Optional: if you want to check user validity
    private readonly recordService: RecordService
  ) { }
  async send(token: string, title: string, body: string) {
    return admin.messaging().send({
      token,
      notification: { title, body },
    });
  }

  async getAllNotifications(req: any) {
    const { _id } = req.user;
    const { pageno, limit, type, filter, user } = req.query || {};


    let obj: any = {
      ...filter,
      user: new mongoose.Types.ObjectId(user || _id), // Filter by user ID (either from query or authenticated user)
    };
    if (type) {
      obj.type = type; // Filter by notification type if provided
    }
    try {
      const pipeline: any[] = [{ $match: obj }, { $sort: { createdAt: -1 } }]; // Match the filter
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.notificationModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
      const unReadCount = await this.notificationModel.countDocuments({
        user: new mongoose.Types.ObjectId(user || _id),
        isRead: false,
      });
      result.meta.unReadCount = unReadCount; // Add unread count to the result
      return result;
    } catch (err) {
      throw new Error(err?.message);
    }
  }

  async markAsRead(notificationId: string) {
    return this.notificationModel
      .findByIdAndUpdate(notificationId, { isRead: true }, { new: true })
      .exec();
  }

  async markAllAsRead(userId: string) {
    return this.notificationModel
      .updateMany({ user: userId }, { isRead: true })
      .exec();
  }

  async deleteNotification(notificationId: string, userId: string) {
    await this.notificationModel
      .findOneAndDelete({
        _id: new mongoose.Types.ObjectId(notificationId),
        user: userId,
      })
      .exec();
    return { message: 'Notification deleted successfully' };
  }

  async deleteAllNotifications(userId: string) {
    await this.notificationModel.deleteMany({ user: userId }).exec();
    return { message: 'All notifications deleted successfully' };
  }
  async sendNotification(body: any) {
    try {
      let { userId, title, message, type, object } = body;
      userId = userId.toString();
      const notification = new this.notificationModel({
        user: userId,
        title,
        message,
        type,
        object: object,
      });

      await notification.save(); // Save the notification to the DB
      const userDevices = await this.deviceModel
        .findOne({ user: new mongoose.Types.ObjectId(userId) })
        .exec();

      if (!userDevices) {
        throw new Error('User devices not found');
      }
      // Step 2: Filter valid device tokens (device_id should not be empty)
      const validTokens = userDevices.devices
        .filter(
          (device) =>
            device.device_id &&
            device.device_id.trim() &&
            device.device_id.length > 50,
        ) // Remove empty or invalid tokens
        .map((device) => device.device_id); // Extract valid device tokens

      if (validTokens.length === 0) {
        throw new Error('No valid devices found for user');
      }

      // Step 4: Send multicast message using Firebase Admin
      const notifyPayload = {
        notification: {
          title,
          body: message,
        },
        data: {
          type,
          ...object, // Include any additional data (e.g., order details, chat info)
        },
        tokens: validTokens, // Send to multiple devices
      };

      const response = await admin
        .messaging()
        .sendEachForMulticast(notifyPayload);
      return {
        message: 'Notification sent successfully',
        data: {
          delivered: response.successCount,
          failed: response.failureCount,
        },
      };
    } catch (error) {
      return { success: false, message: error.message || 'Unknown error' };
    }
  }

  async updateUserStatus(userId: string, notificationId: string) {

    try {

      const isNotificationExist = await this.notificationModel.findOne({ _id: notificationId });


      if (!isNotificationExist) {

        throw new NotFoundException('Notification not found')
      }

      if (isNotificationExist.user.toString() !== userId) {

        throw new NotFoundException('Notification not found')
      }
      isNotificationExist.object.status = "normal"

      return await isNotificationExist.save()

    } catch (error) {
      throw new Error(error?.message)
    }

  }

  async handleCall911(userId: string, notificationId: string) {
    try {

      const notification = await this.notificationModel.findOne({
        _id: notificationId,
        user: userId
      });

      if (!notification) throw new NotFoundException('Notification not found');

      if (notification.object?.status !== 'critical') {
        throw new Error('Only critical notifications can trigger 911');
      }
      if (notification.object.actioned) {
        throw new Error('Notification already actioned')
      }

      // Mark the original critical notification as actioned
      notification.object = { ...notification.object, actioned: true };
      await notification.save();


      let template = this.recordService.buildNotificationContent("emergency",
        notification.object.vitalKey,
        notification.object.value)

      return await this.notificationModel.create({
        user: userId,
        title: template.title,
        message: template.message,
        isRead: false,
        type: 'vital',
        object: {
          _id: notification.object.vitalId,
          key: notification.object.vitalKey,
          value: notification.object.value,
          status: "emergency",
        },
      });


    } catch (error) {
      throw new Error(error?.message)
    }
  }

  async handleCancelEmergency(userId: string, notificationId: string) {

    try {

      const notification = await this.notificationModel.findOne({
        _id: notificationId,
        user:userId,
      });


      if (!notification) throw new NotFoundException('Notification not found');

      if (notification.object?.status !== 'emergency') {
        throw new Error('Only emergency notifications can be cancelled');
      }

      // Mark emergency as cancelled
      notification.object = { ...notification.object, cancelled: true };
      await notification.save();

      let template = this.recordService.buildNotificationContent("911",
        notification.object.vitalKey,
        notification.object.value)

      // Create "911 Contacted" notification
      return await this.notificationModel.create({
        user: userId,
        title: template.title,
        message: template.message,
        isRead: false,
        type: 'vital',
        object: {
          _id: notification.object.vitalId,
          key: notification.object.vitalKey,
          value: notification.object.value,
          status: "911",
        },
      });
    } catch (error) {
      throw new Error(error?.message)
    }
  }
}
