import { Controller, Delete, Get, Post, Put, Request } from '@nestjs/common';
import { AppointmentsService } from '../services/appointment.services';
import { UserType } from '../../user/dto/user.dto';
import { Access } from '../../decorators/public.decorator';

@Controller('appointment')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  // Get available slots based on dynamic duration (in minutes or hours)
  @Post('/slots')
  @Access(UserType.User)
  async getAvailableSlots(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.getAvailableSlots(
      req?.user,
      req?.body,
    );
  }

  @Post('/')
  @Access(UserType.User)
  async addAppointment(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.createAppointment(
      req?.user,
      req?.body,
    );
  }

  @Get('/')
  @Access(UserType.User, UserType.Doctor)
  async getAppointments(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.getAllAppointments(
      req?.user,
      req?.query,
    );
  }

  @Get('/:id')
  @Access(UserType.User, UserType.Doctor)
  async getAppointmentById(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.getAppointmentById(
      req?.user,
      req?.params?.id,
    );
  }

  @Put('/:id')
  @Access(UserType.User, UserType.Doctor)
  async upadteAppointments(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.updateAppointmentStatus(req);
  }
  //Review Endpoints
  @Post('/:id/review')
  @Access(UserType.User)
  async reviewAppointment(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.addReviewToAppointment(req);
  }

  @Put('/:id/review')
  @Access(UserType.User)
  async updateAppointment(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.updateReviewForAppointment(req);
  }

  @Delete('/:id/review')
  @Access(UserType.User)
  async deleteAppointment(
    @Request() req, // User data from JWT or session
  ) {
    return await this.appointmentsService.removeReviewFromAppointment(req);
  }
}
