import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Device, DeviceSchema } from '../user/schemas/devices.schema';
import { Notification, NotificationSchema } from './notification.schema';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';

@Global() // optional but recommended
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Device.name, schema: DeviceSchema },
      { name: Notification.name, schema: NotificationSchema },
    ]),
  ],
  providers: [NotificationService],
  controllers: [NotificationController],
  exports: [NotificationService],
})
export class NotificationModule {}
