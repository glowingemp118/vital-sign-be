import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose'; // Assuming you have a Doctor model
import * as moment from 'moment-timezone'; // For handling timezones
import { Appointment } from '../schemas/appointments.schema';
import { Doctor } from '../../user/schemas/doctor.schema';
import { validateParams } from '../../utils/validations';
import { processObject, processValue } from '../../utils/encrptdecrpt';
import {
  appointmentPipeline,
  finalRes,
  paginationPipeline,
  searchPipeline,
  sort,
} from '../../utils/dbUtils';
import { UserType } from '../../user/dto/user.dto';
import { Review } from '../schemas/reviews.schema';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Appointment.name) private appointmentModel: Model<Appointment>,
    @InjectModel(Doctor.name) private doctorModel: Model<Doctor>,
    @InjectModel(Review.name) private reviewModel: Model<Review>,
  ) {}
  async getAppointmentStatusCounts(user: any, year?: number, month?: number) {
    const match = this.buildMatch(user, year, month);

    const statuses = ['pending', 'confirmed', 'cancelled', 'completed'];

    const result = await this.appointmentModel.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    return statuses.reduce(
      (acc, status) => {
        acc[status] = result.find((r) => r._id === status)?.count || 0;
        return acc;
      },
      {} as Record<string, number>,
    );
  }

  async getCompletedGraphStats(
    user: any,
    {
      type = 'month',
      year,
      month,
    }: { type?: 'month' | 'year'; year: number; month?: number },
  ) {
    const match = {
      ...this.buildMatch(user, year, month),
      status: 'completed',
    };

    const groupBy =
      type === 'month' ? { $dayOfMonth: '$date' } : { $month: '$date' };

    const data = await this.appointmentModel.aggregate([
      { $match: match },
      { $group: { _id: groupBy, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    return type === 'month'
      ? this.fillDays(data, year, month!)
      : this.fillMonths(data);
  }

  private buildMatch(user: any, year?: number, month?: number) {
    const match: any = {};
    const { _id, user_type } = user;

    if (user_type === UserType.User)
      match.user = new mongoose.Types.ObjectId(_id);
    if (user_type === UserType.Doctor)
      match.doctor = new mongoose.Types.ObjectId(_id);

    if (!year) return match;

    match.date = month
      ? {
          $gte: moment
            .utc({ year, month: month - 1 })
            .startOf('month')
            .toDate(),
          $lte: moment
            .utc({ year, month: month - 1 })
            .endOf('month')
            .toDate(),
        }
      : {
          $gte: moment.utc({ year }).startOf('year').toDate(),
          $lte: moment.utc({ year }).endOf('year').toDate(),
        };

    return match;
  }

  private fillDays(data: any[], year: number, month: number) {
    const days = moment.utc({ year, month: month - 1 }).daysInMonth();
    return Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      count: data.find((d) => d._id === i + 1)?.count || 0,
    }));
  }

  private fillMonths(data: any[]) {
    return Array.from({ length: 12 }, (_, i) => ({
      month: moment().month(i).format('MMM'),
      count: data.find((d) => d._id === i + 1)?.count || 0,
    }));
  }
}
