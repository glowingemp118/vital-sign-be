// src/modules/admin.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import {
  Settings,
  SettingsSchema,
  Faq,
  FaqSchema,
  ContactSupportSchema,
  ContactSupport,
} from './schemas/admin.schema';
import { User, UserSchema } from '../user/schemas/user.schema';
import { Speciality, SpecialitySchema } from './schemas/speciality.schema';
import { Doctor, DoctorSchema } from '../user/schemas/doctor.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Settings.name, schema: SettingsSchema },
      { name: Faq.name, schema: FaqSchema },
      { name: ContactSupport.name, schema: ContactSupportSchema },
      { name: User.name, schema: UserSchema },
      { name: Speciality.name, schema: SpecialitySchema },
      { name: Doctor.name, schema: DoctorSchema },
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
