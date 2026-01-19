import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Request,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { UserType } from '../../user/dto/user.dto';
import { Access, Public } from '../../decorators/public.decorator';
import { FeatureService } from '../services/feature.services';
import { CloudinaryService } from '../../utils/cloudinary';
import { FileInterceptor } from '@nestjs/platform-express';
@Controller('')
export class FeatureController {
  constructor(
    private readonly featureService: FeatureService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  @Get('/doctor')
  async getDoctors(
    @Request() req, // User data from JWT or session
  ) {
    return await this.featureService.getDoctors(req);
  }

  @Get('/doctor/:id')
  async getDrbyId(
    @Request() req, // User data from JWT or session
  ) {
    return await this.featureService.getDoctorById(req);
  }

  @Get('/doctor/:id/reviews')
  async drReviews(
    @Request() req, // User data from JWT or session
  ) {
    return await this.featureService.getDrReviews(req);
  }

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
