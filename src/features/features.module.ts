import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecordController } from './controllers/records.controller';
import { RecordService } from './services/records.services';
import { Record, RecordSchema } from './schemas/records.schema';
import { AppointmentsController } from './controllers/appointments.controller';
import { AppointmentsService } from './services/appointment.services';
import { Doctor, DoctorSchema } from 'src/user/schemas/doctor.schema';
import { Appointment, AppointmentSchema } from './schemas/appointments.schema';
import { Review, ReviewSchema } from './schemas/reviews.schema';
import { FeatureController } from './controllers/feature.controller';
import { FeatureService } from './services/feature.services';
import { CloudinaryService } from 'src/utils/cloudinary';
import { Vital, VitalSchema } from './schemas/vital.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Record.name, schema: RecordSchema },
      { name: Doctor.name, schema: DoctorSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Review.name, schema: ReviewSchema },
      { name: Vital.name, schema: VitalSchema },
    ]),
  ],
  controllers: [FeatureController, RecordController, AppointmentsController],
  providers: [
    FeatureService,
    RecordService,
    AppointmentsService,
    CloudinaryService,
  ],
})
export class FeaturesModule {}
