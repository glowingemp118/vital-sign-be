import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';

import { HealthVoiceController } from './health-voice.controller';
import { HealthVoiceService } from './health-voice.service';
import { Voice, VoiceSchema } from './schemas/voice.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Voice.name, schema: VoiceSchema }]),
    MulterModule.register({ dest: './uploads' }),
  ],
  controllers: [HealthVoiceController],
  providers: [HealthVoiceService],
  exports: [HealthVoiceService],
})
export class HealthVoiceModule {}
