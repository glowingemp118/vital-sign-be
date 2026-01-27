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
import { FeatureService } from './services/feature.services';
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
    ]),
  ],
  controllers: [
    FeatureController,
    RecordController,
    AppointmentsController,
    NotificationController,
  ],
  providers: [
    FeatureService,
    RecordService,
    AppointmentsService,
    CloudinaryService,
    NotificationService,
  ],
  exports: [NotificationService],
})
export class FeaturesModule {}
