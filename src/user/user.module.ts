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
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
      { name: Doctor.name, schema: DoctorSchema },
      { name: Speciality.name, schema: SpecialitySchema },
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
