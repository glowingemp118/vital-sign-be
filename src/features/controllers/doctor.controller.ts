import { Controller, Get, Request } from '@nestjs/common';
import { DoctorService } from '../services/doctor.services';
@Controller('')
export class DoctorController {
  constructor(private readonly doctorService: DoctorService) {}

  @Get('/doctor')
  async getDoctors(
    @Request() req, // User data from JWT or session
  ) {
    return await this.doctorService.getDoctors(req);
  }

  @Get('/doctor/:id')
  async getDrbyId(
    @Request() req, // User data from JWT or session
  ) {
    return await this.doctorService.getDoctorById(req);
  }

  @Get('/doctor/:id/reviews')
  async drReviews(
    @Request() req, // User data from JWT or session
  ) {
    return await this.doctorService.getDrReviews(req);
  }
}
