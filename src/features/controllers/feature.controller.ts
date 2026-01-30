import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Public } from '../../decorators/public.decorator';
import { CloudinaryService } from '../../utils/cloudinary';
import { FileInterceptor } from '@nestjs/platform-express';
@Controller('')
export class FeatureController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}
  //files
  @Post('/file/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    return await this.cloudinaryService.uploadFile(file);
  }

  //files
  @Post('/file/upload/public')
  @Public()
  @UseInterceptors(FileInterceptor('file'))
  async uploadFilePublic(@UploadedFile() file: Express.Multer.File) {
    return await this.cloudinaryService.uploadFile(file);
  }
}
