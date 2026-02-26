// src/controllers/admin.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Delete,
  Param,
  Put,
  Query,
  Request,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { Access, Public } from '../decorators/public.decorator';
import { UserType } from '../user/dto/user.dto';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  //login
  @Post('login')
  @Public()
  async signIn(@Body() signInDto: any) {
    return this.adminService.signIn(signInDto);
  }

  // Settings Endpoints
  @Get('tac')
  @Public()
  async getTAC() {
    return this.adminService.getSettings('tac');
  }

  @Get('privacy')
  @Public()
  async getPrivacy() {
    return this.adminService.getSettings('privacy');
  }

  @Get('about')
  @Public()
  async getAbout() {
    return this.adminService.getSettings('about');
  }

  @Put('about')
  @Access(UserType.Admin)
  async saveAbout(@Body() body: { about: string }) {
    return this.adminService.saveSettings('about', body.about);
  }

  @Put('privacy')
  @Access(UserType.Admin)
  async savePrivacy(@Body() body: { privacy: string }) {
    return this.adminService.saveSettings('privacy', body.privacy);
  }

  @Put('tac')
  @Access(UserType.Admin)
  async saveTerms(@Body() body: { tac: string }) {
    return this.adminService.saveSettings('tac', body.tac);
  }

  // FAQ Endpoints
  @Post('faq')
  @Access(UserType.Admin)
  async createFaq(@Body() body: { question: string; answer: string }) {
    return this.adminService.createFaq(body.question, body.answer);
  }

  @Put('faq/:id')
  @Access(UserType.Admin)
  async updateFaq(
    @Param('id') id: string,
    @Body() body: { question: string; answer: string },
  ) {
    return this.adminService.updateFaq(id, body.question, body.answer);
  }

  @Delete('faq/:id')
  @Access(UserType.Admin)
  async deleteFaq(@Param('id') id: string) {
    return this.adminService.deleteFaq(id);
  }

  @Get('faq')
  @Public()
  async getAllFaqs(@Query() query: any) {
    return this.adminService.getAllFaqs({ ...query });
  }

  @Post('support')
  @Public()
  async createRequest(
    @Body()
    body: {
      email: string;
      name: string;
      subject: string;
      message: string;
    },
  ) {
    return this.adminService.createRequest(body);
  }
  @Put('support/:id')
  @Access(UserType.Admin)
  async updateRequest(
    @Param('id') id: string,
    @Body() body: { reply?: string; status?: string },
  ) {
    return this.adminService.updateRequest(id, body);
  }

  @Delete('support/:id')
  @Access(UserType.Admin)
  async deleteRequest(@Param('id') id: string) {
    return this.adminService.deleteRequest(id);
  }

  @Get('contact-support')
  @Access(UserType.Admin)
  async getRequests(@Query() query: any) {
    return this.adminService.getRequests({ ...query });
  }

  // Specialty Endpoints
  @Post('specialty')
  @Access(UserType.Admin)
  async addSpecialty(
    @Body()
    body: {
      title: string;
      description: string;
      image?: string;
    },
  ) {
    return this.adminService.addSpecialty(body);
  }

  @Put('specialty/:id')
  @Access(UserType.Admin)
  async updateSpecialty(
    @Param('id') id: string,
    @Body() body: { title?: string; description?: string; image?: string },
  ) {
    return this.adminService.updateSpecialty(id, body);
  }

  @Get('specialty/:id')
  @Access(UserType.Admin)
  async getSpecialtyById(@Param('id') id: string) {
    return this.adminService.getSpecialtyById(id);
  }

  @Get('specialty')
  @Public()
  async getAllSpecialties(@Query() query: any) {
    return this.adminService.getAllSpecialties({ ...query });
  }

  @Delete('specialty/:id')
  @Access(UserType.Admin)
  async deleteSpecialty(@Param('id') id: string) {
    return this.adminService.deleteSpecialty(id);
  }

  // Doctor Endpoints
  @Post('doctor')
  @Access(UserType.Admin)
  async addDoctor(
    @Body()
    body: {
      name: string;
      email: string;
      password: string;
      country?: string;
      gender?: string;
      phone?: string;
      specialties: string;
      experience: string;
      about?: string;
      image?: string;
    },
  ) {
    return this.adminService.addDoctor(body);
  }

  @Put('user/:id')
  @Access(UserType.Admin)
  async updateUser(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
    },
  ) {
    return this.adminService.updateUserStatus(id, body.status);
  }
}
