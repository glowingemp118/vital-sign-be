import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { JWT_SECRET } from '../constants/constants';
import { JwtModule } from '@nestjs/jwt';
import { Device, DeviceSchema } from './schemas/devices.schema';
import { Doctor, DoctorSchema } from './schemas/doctor.schema';
import {
  Speciality,
  SpecialitySchema,
} from '../admin/schemas/speciality.schema';
import {
  Appointment,
  AppointmentSchema,
} from 'src/features/schemas/appointments.schema';
import {
  ContactType,
  ContactTypeSchema,
} from 'src/contact-type/schemas/contac-type.schema';
import {
  Notification,
  NotificationSchema,
} from 'src/notification/notification.schema';
import { Alert, AlertSchema } from 'src/features/schemas/alert.schema';
import { Record, RecordSchema } from 'src/features/schemas/records.schema';
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
      { name: Doctor.name, schema: DoctorSchema },
      { name: Speciality.name, schema: SpecialitySchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: ContactType.name, schema: ContactTypeSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: Record.name, schema: RecordSchema },
      { name: Alert.name, schema: AlertSchema },
    ]),
    JwtModule.register({
      global: true,
      secret: JWT_SECRET,
      signOptions: {
        expiresIn: '1h',
      },
    }),
  ],
  providers: [UserService],
  controllers: [UserController],
})
export class UserModule {}
