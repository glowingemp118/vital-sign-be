import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Res,
  Request,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { UserType } from 'src/user/dto/user.dto';
import { Access } from 'src/decorators/public.decorator';
import { FeatureService } from '../services/feature.services';
import { CloudinaryService } from 'src/utils/cloudinary';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
@Controller('')
export class FeatureController {
  constructor(
    private readonly featureService: FeatureService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  @Get('/')
  root(@Res() res: Response) {
    return res.send('Hello from Node.js!');
  }

  @Get('/favicon.ico')
  faviconIco(@Res() res: Response) {
    return res.status(204).end();
  }

  @Get('/favicon.png')
  faviconPng(@Res() res: Response) {
    return res.status(204).end();
  }

  @Get('/doctor')
  @Access(UserType.User)
  async getDoctors(
    @Request() req, // User data from JWT or session
  ) {
    return await this.featureService.getDoctors(req);
  }

  @Get('/doctor/:id')
  @Access(UserType.User)
  async getDrbyId(
    @Request() req, // User data from JWT or session
  ) {
    return await this.featureService.getDoctorById(req);
  }

  @Get('/doctor/:id/reviews')
  @Access(UserType.User)
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
}
