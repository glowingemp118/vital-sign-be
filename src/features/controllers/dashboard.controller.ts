import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from '../services/dashboard.services';

@Controller('')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('/dashboard')
  @ApiBearerAuth()
  getDashboardStats(@Request() req) {
    return this.dashboardService.getDashboardStats(req);
  }
}
