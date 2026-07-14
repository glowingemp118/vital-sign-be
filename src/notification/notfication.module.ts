import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Device, DeviceSchema } from '../user/schemas/devices.schema';
import { NotificationController } from './notification.controller';
import { Notification, NotificationSchema } from './notification.schema';
import { NotificationService } from './notification.service';
import { ApnsVoipService } from './apns-voip.service';
import { Vital, VitalSchema } from 'src/features/schemas/vital.schema';
import { User, UserSchema } from 'src/user/schemas/user.schema';
import {
  Appointment,
  AppointmentSchema,
} from 'src/features/schemas/appointments.schema';
import { Alert, AlertSchema } from 'src/features/schemas/alert.schema';

@Global() // optional but recommended
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Device.name, schema: DeviceSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: Vital.name, schema: VitalSchema },
      { name: User.name, schema: UserSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Alert.name, schema: AlertSchema },
    ]),
  ],
  providers: [NotificationService, ApnsVoipService],
  controllers: [NotificationController],
  exports: [NotificationService, ApnsVoipService],
})
export class NotificationModule {}
