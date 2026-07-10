import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserModule } from './user/user.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './guards/auth.guard';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config'; // Import ConfigModule
import * as path from 'path';
import { AdminModule } from './admin/admin.module';
import { FeaturesModule } from './features/features.module';
import { AccessGuard } from './guards/access.guard';
import { ChatModule } from './chat/chat.module';
import { NotificationModule } from './notification/notfication.module';
import { HealthVoiceModule } from './health-voice/health-voice.module';
import { ContactTypeModule } from './contact-type/contact-type.module';
import { ChatBotModule } from './chat-bot/chat-bot.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: path.resolve(__dirname, '..', '.env'), // Load .env file from root
      isGlobal: true, // This makes the configuration globally available across the app
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 10,
      },
    ]),
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.DATABASE_URL,
        retryAttempts: Number.MAX_SAFE_INTEGER, // never give up
        retryDelay: 5000, // 5s between attempts
        serverSelectionTimeoutMS: 10000,
        heartbeatFrequencyMS: 10000,
        connectionFactory: (connection) => {
          connection.on('connected', () => console.log('✅ Mongo connected'));
          connection.on('disconnected', () =>
            console.warn('⚠️ Mongo disconnected — retrying...'),
          );
          connection.on('error', (e) =>
            console.error('❌ Mongo error:', e.message),
          );
          return connection;
        },
      }),
    }),
    // TodoModule,
    AdminModule,
    UserModule,
    FeaturesModule,
    ChatModule,
    NotificationModule,
    HealthVoiceModule,
    ContactTypeModule,
    ChatBotModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AccessGuard,
    },
    // {
    //   provide: APP_GUARD,
    //   useClass: ThrottlerGuard,
    // },
  ],
})
export class AppModule {}
