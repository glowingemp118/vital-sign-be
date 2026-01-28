import { Injectable } from '@nestjs/common';
import admin from '../config/firebase';
import { InjectModel } from '@nestjs/mongoose';
import { Device } from 'src/user/schemas/devices.schema';
import mongoose, { Model } from 'mongoose';
import { Notification } from './notification.schema';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';

@Injectable()
export class NotificationService {
  constructor(
    @InjectModel(Device.name) private readonly deviceModel: Model<Device>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>, // Optional: if you want to check user validity
  ) {}
  async send(token: string, title: string, body: string) {
    return admin.messaging().send({
      token,
      notification: { title, body },
    });
  }

  async getAllNotifications(req: any) {
    const { _id } = req.user;
    const { pageno, limit, search, filter, user } = req.query || {};

    let obj: any = {
      ...filter,
      user: user || _id,
    };
    try {
      const pipeline: any[] = [{ $match: obj }, { $sort: { createdAt: -1 } }]; // Match the filter
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.notificationModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
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
    return this.notificationModel
      .findOneAndDelete({
        _id: new mongoose.Types.ObjectId(notificationId),
        user: userId,
      })
      .exec();
  }

  async deleteAllNotifications(userId: string) {
    return this.notificationModel.deleteMany({ user: userId }).exec();
  }
  async sendNotification(body: any) {
    try {
      const { userId, title, message, type, object } = body;
      const notification = new this.notificationModel({
        user: userId,
        title,
        message,
        type,
        object: object,
      });

      await notification.save(); // Save the notification to the DB
      const userDevices = await this.deviceModel
        .findOne({ user: userId })
        .exec();

      if (!userDevices) {
        throw new Error('User devices not found');
      }

      // Step 2: Filter valid device tokens (device_id should not be empty)
      const validTokens = userDevices.devices
        .filter((device) => device.device_id && device.device_id.trim()) // Remove empty or invalid tokens
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
}
