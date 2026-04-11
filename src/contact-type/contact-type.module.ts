import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';
import { ContactType, ContactTypeSchema } from './schemas/contac-type.schema';
import { ContactTypeController } from './contact-type.controller';
import { ContactTypeService } from './contact-type.service';


@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: ContactType.name, schema: ContactTypeSchema },
    ]),
    MulterModule.register({ dest: './uploads' }),
  ],
  controllers: [ContactTypeController],
  providers: [ContactTypeService],
  exports: [ContactTypeService],
})
export class ContactTypeModule { }
