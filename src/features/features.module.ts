import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecordController } from './controllers/records.controller';
import { RecordService } from './services/records.services';
import { Record, RecordSchema } from './schemas/records.schema';
import { AppointmentsController } from './controllers/appointments.controller';
import { AppointmentsService } from './services/appointment.services';
import { Doctor, DoctorSchema } from '../user/schemas/doctor.schema';
import { Appointment, AppointmentSchema } from './schemas/appointments.schema';
import { Review, ReviewSchema } from './schemas/reviews.schema';
import { FeatureController } from './controllers/feature.controller';
import { CloudinaryService } from '../utils/cloudinary';
import { Vital, VitalSchema } from './schemas/vital.schema';
import { NotificationController } from '../notification/notification.controller';
import { NotificationService } from '../notification/notification.service';
import { Device, DeviceSchema } from 'src/user/schemas/devices.schema';
import {
  Notification,
  NotificationSchema,
} from '../notification/notification.schema';
import { NotificationModule } from 'src/notification/notfication.module';
import { User, UserSchema } from 'src/user/schemas/user.schema';
import { DoctorService } from './services/doctor.services';
import { DoctorController } from './controllers/doctor.controller';
import { DashboardController } from './controllers/dashboard.controller';
import { DashboardService } from './services/dashboard.services';
import {
  ContactSupport,
  ContactSupportSchema,
} from 'src/admin/schemas/admin.schema';
import { Alert, AlertSchema } from './schemas/alert.schema';
import { Message, MessageSchema } from 'src/chat/schemas/message.schema';

@Module({
  imports: [
    NotificationModule,
    MongooseModule.forFeature([
      { name: Record.name, schema: RecordSchema },
      { name: Doctor.name, schema: DoctorSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Review.name, schema: ReviewSchema },
      { name: Vital.name, schema: VitalSchema },
      { name: Device.name, schema: DeviceSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: User.name, schema: UserSchema },
      { name: ContactSupport.name, schema: ContactSupportSchema },
      { name: Alert.name, schema: AlertSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [
    FeatureController,
    RecordController,
    AppointmentsController,
    NotificationController,
    DoctorController,
    DashboardController,
  ],
  providers: [
    DoctorService,
    RecordService,
    AppointmentsService,
    CloudinaryService,
    NotificationService,
    DashboardService,
  ],
  exports: [NotificationService],
})
export class FeaturesModule {}
