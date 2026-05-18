import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';

import { Notification, NotificationSchema } from 'src/notification/notification.schema';
import { CloudinaryService } from 'src/utils/cloudinary';
import { HealthVoiceController } from './health-voice.controller';
import { HealthVoiceService } from './health-voice.service';
import { Voice, VoiceSchema } from './schemas/voice.schema';

@Module({
  imports: [
    ConfigModule,
    // FeaturesModule,
    MongooseModule.forFeature([
      { name: Voice.name, schema: VoiceSchema },
      { name: Notification.name, schema: NotificationSchema }
    ]),
    MulterModule.register({ dest: './uploads' }),
  ],
  controllers: [HealthVoiceController],
  providers: [HealthVoiceService,CloudinaryService],
  exports: [HealthVoiceService],
})
export class HealthVoiceModule { }
