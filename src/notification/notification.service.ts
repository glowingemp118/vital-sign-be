import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { Device } from 'src/user/schemas/devices.schema';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import admin from '../config/firebase';
import { Notification } from './notification.schema';
import { Alert } from 'src/features/schemas/alert.schema';
import { ApnsVoipService } from './apns-voip.service';

type TemplateFn = (
  vitalName: string,
  value: any,
) => {
  title: string;
  message: string;
};
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectModel(Device.name) private readonly deviceModel: Model<Device>,
    @InjectModel(Alert.name) private readonly alertModel: Model<Alert>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    private readonly apnsVoipService: ApnsVoipService,
  ) {}

  /** Devices docs may have user as ObjectId or legacy string — try both. */
  private async findUserDevices(userId: string) {
    const id = userId?.toString();
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;

    let doc = await this.deviceModel
      .findOne({ user: new mongoose.Types.ObjectId(id) })
      .lean();
    if (!doc) {
      doc = await this.deviceModel.findOne({ user: id }).lean();
    }
    return doc;
  }

  private VITAL_NOTIFICATION_TEMPLATES: Record<string, TemplateFn> = {
    low: (vitalName, value) => ({
      title: `Health Alert — Check In Required`,
      message: `Your vitals are slightly below normal. Are you feeling okay?`,
    }),

    medium: (vitalName, value) => ({
      title: `Health Alert — Monitor Recommended`,
      message: `Your vitals are mildly abnormal. Keep an eye on your condition.`,
    }),

    high: (vitalName, value) => ({
      title: `Health Alert — Check In Required`,
      message: `Your vitals show an unusual pattern. Are you feeling okay?`,
    }),

    critical: (vitalName, value) => ({
      title: `High Risk Detected — Response Required`,
      message: `Your pulse spiked significantly. Are you in pain? Respond immediately.`,
    }),

    emergency: (vitalName, value) => ({
      title: `CRITICAL ALERT — Emergency Response Initiated`,
      message: `Emergency services have been contacted. Tap if you are conscious.`,
    }),

    '911': (vitalName, value) => ({
      title: `911 Contacted`,
      message: `Emergency services were notified with your location and vitals report.`,
    }),
  };

  buildNotificationContent(
    vstatus: string,
    vitalName: string,
    value: any,
  ): { title: string; message: string } {
    const template =
      this.VITAL_NOTIFICATION_TEMPLATES[vstatus] ||
      this.VITAL_NOTIFICATION_TEMPLATES['low'];
    return template(vitalName, value);
  }

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
      // user: new mongoose.Types.ObjectId(user || _id), // Filter by user ID (either from query or authenticated user)
      $or: [
        { user: new mongoose.Types.ObjectId(user || _id) },
        { user: user || _id },
      ],
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
        // user: new mongoose.Types.ObjectId(user || _id),
        $or: [
          { user: new mongoose.Types.ObjectId(user || _id) },
          { user: user || _id },
        ],
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
      userId = userId?.toString();

      const userDevices = await this.findUserDevices(userId);

      if (!userDevices?.devices || userDevices.devices.length === 0) {
        this.logger.warn(
          `[FCM] User devices not found userId=${userId} — iOS must send device_id (FCM) on login or PUT /auth/device-tokens`,
        );
        return {
          success: false,
          message: 'User devices not found',
        };
      }

      const iosWithVoipOnly = userDevices.devices.filter(
        (d) =>
          String(d.device_type || '').toLowerCase() === 'ios' &&
          d.voip_token &&
          (!d.device_id || d.device_id.trim().length <= 50),
      );

      const validTokens = [
        ...new Set(
          userDevices.devices
            .filter(
              (device) =>
                device.device_id &&
                device.device_id.trim() &&
                device.device_id.length > 50,
            )
            .map((device) => device.device_id!.trim()),
        ),
      ];

      if (validTokens.length === 0) {
        this.logger.warn(
          `[FCM] No FCM device_id for userId=${userId} devices=${userDevices.devices.length} voipOnlyIos=${iosWithVoipOnly.length} — VoIP token alone cannot receive vital/appointment FCM`,
        );
        return {
          success: false,
          message: 'No valid FCM device_id found for user',
        };
      }

      this.logger.log(
        `[FCM] send userId=${userId} tokens=${validTokens.length} project=${process.env.FIREBASE_PROJECT_ID}`,
      );

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      await this.notificationModel.updateOne(
        {
          user: userId,
          title,
          message,
          type,
          object,
          createdAt: { $gte: fiveMinutesAgo },
        },
        {
          $set: {
            updatedAt: new Date(),
          },
          $setOnInsert: {
            user: userId,
            title,
            message,
            type,
            object,
          },
        },
        {
          upsert: true,
        },
      );

      const data = Object.fromEntries(
        Object.entries({ type, ...object }).map(([key, value]) => [
          key,
          value == null ? '' : String(value),
        ]),
      );

      const notifyPayload = {
        notification: {
          title,
          body: message,
        },
        data,
        tokens: validTokens,
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(notifyPayload);

      const staleTokens: string[] = [];
      response.responses.forEach((r, i) => {
        if (r.error) {
          const code = (r.error as any).code || '';
          this.logger.error(
            `[FCM] fail token=...${validTokens[i].slice(-8)} code=${code} msg=${r.error.message}`,
          );
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            staleTokens.push(validTokens[i]);
          }
          if (code === 'messaging/third-party-auth-error') {
            this.logger.error(
              `[FCM] third-party-auth-error — Firebase cannot auth to Apple APNs. ` +
                `Upload an APNs Auth Key (.p8) in Firebase Console → Project settings → Cloud Messaging → Apple app (${process.env.APNS_BUNDLE_ID || 'com.mexidoc'}). ` +
                `Backend MexidocCertificates.p12 is VoIP-only and does NOT fix FCM iOS. project=${process.env.FIREBASE_PROJECT_ID}`,
            );
          }
        } else {
          this.logger.log(
            `[FCM] ok token=...${validTokens[i].slice(-8)} messageId=${r.messageId || 'n/a'}`,
          );
        }
      });

      if (staleTokens.length > 0) {
        await this.deviceModel.updateMany(
          {
            $or: [
              { user: new mongoose.Types.ObjectId(userId) },
              { user: userId },
            ],
          },
          { $pull: { devices: { device_id: { $in: staleTokens } } } },
        );
        this.logger.warn(
          `[FCM] removed ${staleTokens.length} stale token(s) for user=${userId}`,
        );
      }

      console.log(
        'Firebase response:',
        response?.failureCount,
        response?.successCount,
      );
      return {
        message: 'Notification sent successfully',
        data: {
          delivered: response.successCount,
          failed: response.failureCount,
        },
      };
    } catch (error: any) {
      console.error('Error sending notification:', error?.message || error);
      return { success: false, message: error?.message || 'Unknown error' };
    }
  }

  /**
   * Incoming call push:
   * - iOS: APNs VoIP (PushKit) — required when app is background/killed
   * - Android: high-priority FCM data message (existing behavior)
   * Omits WebRTC SDP offer from VoIP (size limits); store offer server-side.
   */
  async sendIncomingCallPush(params: {
    userId: string;
    uuid: string;
    callerId: string;
    callerName: string;
    callerAvatar?: string;
    callType: 'audio' | 'video';
    title?: string;
    message?: string;
  }) {
    const {
      userId,
      uuid,
      callerId,
      callerName,
      callerAvatar = '',
      callType,
      title = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call',
      message = `${callerName || 'Someone'} is calling you`,
    } = params;

    const userDevices = await this.findUserDevices(userId);

    if (!userDevices?.devices?.length) {
      this.logger.warn(`[CallPush] no devices for user=${userId}`);
      return { voipSent: 0, fcmSent: 0 };
    }

    const voipTokens = [
      ...new Set(
        userDevices.devices
          .filter(
            (d) =>
              String(d.device_type || '').toLowerCase() === 'ios' &&
              d.voip_token &&
              d.voip_token.trim().length > 10,
          )
          .map((d) => d.voip_token!.trim()),
      ),
    ];

    // Incoming-call FCM is Android-only (iOS killed→background uses VoIP PushKit).
    // Prefer the *latest* Android FCM token — older ones often return
    // messaging/registration-token-not-registered and can steal "fcmSent=1"
    // while the current phone gets nothing.
    const androidDevices = userDevices.devices.filter(
      (d) =>
        String(d.device_type || '').toLowerCase() === 'android' &&
        d.device_id &&
        d.device_id.trim().length > 50,
    );
    const latestAndroidToken =
      androidDevices.length > 0
        ? androidDevices[androidDevices.length - 1].device_id!.trim()
        : null;
    const androidFcmTokens = latestAndroidToken ? [latestAndroidToken] : [];

    let voipSent = 0;
    for (const token of voipTokens) {
      const ok = await this.apnsVoipService.sendVoipPush(token, {
        uuid,
        callUUID: uuid,
        handle: callerId,
        callerId,
        callerName: callerName || 'Unknown',
        callerAvatar: callerAvatar || '',
        callType,
        type: 'incoming_call',
      });
      if (ok) voipSent += 1;
    }

    let fcmSent = 0;
    if (androidFcmTokens.length > 0) {
      try {
        /**
         * Android killed / background call wake-up:
         * - High-priority DATA message (no top-level `notification`) so
         *   FirebaseMessagingService / Notifee / CallKeep JS can run.
         * - If `notification` is present, Android shows a tray banner and
         *   may never open the Accept/Decline call UI when the app is killed.
         */
        const data: Record<string, string> = {
          type: 'incoming_call',
          uuid: String(uuid),
          callUUID: String(uuid),
          handle: String(callerId),
          callerId: String(callerId),
          callerName: String(callerName || 'Unknown'),
          callerAvatar: String(callerAvatar || ''),
          callType: String(callType),
          title: String(title),
          body: String(message),
          channelId: 'incoming_calls',
          priority: 'high',
          importance: 'high',
        };

        const response = await admin.messaging().sendEachForMulticast({
          tokens: androidFcmTokens,
          data,
          android: {
            priority: 'high',
            ttl: 45000,
            collapseKey: `incoming_call_${uuid}`,
          },
        });

        fcmSent = response.successCount;
        const staleTokens: string[] = [];
        response.responses.forEach((r, i) => {
          const token = androidFcmTokens[i];
          if (r.error) {
            this.logger.error(
              `[CallPush] Android FCM fail token=...${token.slice(-8)} code=${r.error.code} msg=${r.error.message}`,
            );
            if (
              r.error.code === 'messaging/registration-token-not-registered' ||
              r.error.code === 'messaging/invalid-registration-token'
            ) {
              staleTokens.push(token);
            }
          } else {
            this.logger.log(
              `[CallPush] Android FCM ok token=...${token.slice(-8)} messageId=${r.messageId || 'n/a'}`,
            );
          }
        });

        if (staleTokens.length > 0) {
          await this.deviceModel.updateMany(
            {
              $or: [
                { user: new mongoose.Types.ObjectId(userId) },
                { user: userId },
              ],
            },
            { $pull: { devices: { device_id: { $in: staleTokens } } } },
          );
          this.logger.warn(
            `[CallPush] removed ${staleTokens.length} stale Android FCM token(s) for user=${userId}`,
          );
        }

        this.logger.log(
          `[CallPush] Android FCM data-only delivered=${response.successCount} failed=${response.failureCount} tokens=${androidFcmTokens.length}`,
        );
      } catch (err: any) {
        this.logger.error(`[CallPush] FCM error: ${err?.message || err}`);
      }
    } else {
      this.logger.warn(
        `[CallPush] no Android FCM device_id for user=${userId} — login must send device_id + device_type=android`,
      );
    }

    this.logger.log(
      `[CallPush] user=${userId} voipTokens=${voipTokens.length} voipSent=${voipSent} androidFcm=${androidFcmTokens.length} fcmSent=${fcmSent}`,
    );

    return {
      voipSent,
      fcmSent,
      voipTokens: voipTokens.length,
      fcmTokens: androidFcmTokens.length,
    };
  }

  async updateUserStatus(userId: string, notificationId: string) {
    try {
      const notification =
        await this.notificationModel.findById(notificationId);

      if (!notification) {
        throw new NotFoundException('Notification not found');
      }

      if (notification.user.toString() !== userId) {
        throw new ForbiddenException(
          'You are not allowed to update this notification',
        );
      }
      notification.object.status = 'normal';

      notification.markModified('object');

      return await notification.save();
    } catch (error) {
      throw new Error(error?.message);
    }
  }

  async handleCall911(userId: string, notificationId: string) {
    try {
      const notification =
        await this.notificationModel.findById(notificationId);

      if (!notification) {
        throw new NotFoundException('Notification not found');
      }

      if (notification.user.toString() !== userId) {
        throw new ForbiddenException(
          'You are not allowed to update this notification',
        );
      }

      if (notification.object?.status !== 'critical') {
        throw new Error('Only critical notifications can trigger 911');
      }
      if (notification.object.actioned) {
        throw new Error('Notification already actioned');
      }

      // Mark the original critical notification as actioned
      notification.object = { ...notification.object, actioned: true };
      await notification.save();

      let template = this.buildNotificationContent(
        'emergency',
        notification.object.vitalKey,
        notification.object.value,
      );

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
          status: 'emergency',
        },
      });
    } catch (error) {
      throw new Error(error?.message);
    }
  }

  async handleCancelEmergency(userId: string, notificationId: string) {
    try {
      const notification =
        await this.notificationModel.findById(notificationId);

      if (!notification) throw new NotFoundException('Notification not found');

      if (!notification) {
        throw new NotFoundException('Notification not found');
      }

      if (notification.user.toString() !== userId) {
        throw new ForbiddenException(
          'You are not allowed to update this notification',
        );
      }

      if (notification.object?.status !== 'emergency') {
        throw new Error('Only emergency notifications can be cancelled');
      }

      // Mark emergency as cancelled
      notification.object = { ...notification.object, cancelled: true };
      await notification.save();

      let template = this.buildNotificationContent(
        '911',
        notification.object.vitalKey,
        notification.object.value,
      );

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
          status: '911',
        },
      });
    } catch (error) {
      throw new Error(error?.message);
    }
  }
  async YesIAmOk(userId: string) {
    const alert = await this.alertModel.findOne({
      user: new mongoose.Types.ObjectId(userId),
    });

    if (!alert) {
      throw new NotFoundException('No alerts found');
    }

    return await this.alertModel.findByIdAndUpdate(
      alert._id,
      { $set: { alerts: [] } },
      { new: true },
    );
  }
}
