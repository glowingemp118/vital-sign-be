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
    MongooseModule.forRoot(process.env.DATABASE_URL),
    // TodoModule,
    AdminModule,
    UserModule,
    FeaturesModule,
    ChatModule,
    NotificationModule,
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
