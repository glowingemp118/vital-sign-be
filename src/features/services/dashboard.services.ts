import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose'; // Assuming you have a Doctor model
import moment from 'moment'; // For handling timezones
import { Appointment } from '../schemas/appointments.schema';
import { User } from 'src/user/schemas/user.schema';
import { ContactSupport } from 'src/admin/schemas/admin.schema';
import { UserType } from 'src/user/dto/user.dto';
import { statusCounts } from 'src/utils/dbUtils';
import { Message } from 'src/chat/schemas/message.schema';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Appointment.name) private appointmentModel: Model<Appointment>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(ContactSupport.name)
    private contactSupportModel: Model<ContactSupport>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
  ) {}
  async getDashboardStats(req: any): Promise<any> {
    try {
      const { user } = req;
      let { year, filter = {} } = req.query || {};
      year = parseInt(year) || new Date().getFullYear();
      const isDoctor = user?.user_type === UserType.Doctor;
      const appfilter: any = {};
      if (isDoctor) {
        appfilter.doctor = new mongoose.Types.ObjectId(user._id);
        const userIds = await this.appointmentModel.distinct('user', {
          ...appfilter,
          status: { $ne: 'cancelled' },
        });
        filter._id = { $in: userIds };
      }
      const userTypeCounts = await this.userModel.aggregate([
        { $match: { ...filter } },
        {
          $group: {
            _id: '$user_type',
            count: { $sum: 1 },
          },
        },
      ]);
      const patientCount =
        userTypeCounts.find((item) => item._id === UserType.User)?.count || 0;
      const doctorCount =
        userTypeCounts.find((item) => item._id === UserType.Doctor)?.count || 0;

      const [countAppointments = {}] = await this.appointmentModel.aggregate(
        statusCounts(
          ['pending', 'expired', 'confirmed', 'completed', 'cancelled'],
          appfilter,
        ),
      );
      const graphData = await this.getAppointmentsGraphData(year, appfilter);
      const unReadMessages = await this.messageModel.countDocuments({
        objectId: user._id,
        readBy: { $nin: [user._id] },
      });
      const result = {
        patients: patientCount,
        unReadMessages,
        appointments: {
          ...countAppointments,
        },
        graphData,
      };
      if (!isDoctor) {
        const contactSupport = await this.contactSupportModel.aggregate([
          {
            $group: {
              _id: null,
              support: {
                $sum: { $cond: [{ $eq: ['$type', 'support'] }, 1, 0] },
              },
              contact: {
                $sum: { $cond: [{ $eq: ['$type', 'contact'] }, 1, 0] },
              },
            },
          },
        ]);
        result['doctors'] = doctorCount;
        result['contact'] = contactSupport[0]?.contact || 0;
        result['support'] = contactSupport[0]?.support || 0;
      }

      return result;
    } catch (error) {
      console.log(error?.message);

      throw new BadRequestException(error?.message);
    }
  }
  async getAppointmentsGraphData(
    year: number = new Date().getFullYear(),
    filter = {},
  ): Promise<any> {
    const aggregationPipeline: any = [
      {
        // Match appointments for the specified year and filter
        $match: {
          ...filter,
          date: {
            $gte: new Date(`${year}-01-01T00:00:00Z`),
            $lt: new Date(`${year + 1}-01-01T00:00:00Z`),
          },
        },
      },
      {
        // Ensure date is in proper format and extract year and month
        $project: {
          month: { $month: '$date' }, // Extract the month
          status: 1,
        },
      },
      {
        // Group by year and month, and calculate status counts in one step
        $group: {
          _id: '$month', // Group by month
          pending: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
          },
          expired: {
            $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] },
          },
          confirmed: {
            $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] },
          },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
        },
      },
      {
        // Sort by year and month
        $sort: { month: 1 },
      },
    ];

    // Execute the aggregation pipeline
    const result = await this.appointmentModel
      .aggregate(aggregationPipeline)
      .exec();
    // Mapping the month data to include month names and return complete statuses
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];

    const processMonthData = (monthData: any) => {
      // Initialize the result array for the processed months
      const result = [];

      // Iterate over each month (1 to 12)
      monthNames.forEach((monthName, index) => {
        const monthNumber = index + 1;

        // Find the month data for the current month number
        const monthInfo = monthData.find(
          (data: any) => data._id === monthNumber,
        );

        // If the month is found, add it to the result
        if (monthInfo) {
          result.push({
            ...monthInfo, // Copy the found data
            month: monthName, // Add the month name
          });
        } else {
          // If the month is not found, create an entry with 0 counts for all statuses
          result.push({
            _id: monthNumber,
            month: monthName,
            pending: 0,
            confirmed: 0,
            cancelled: 0,
            completed: 0,
            expired: 0,
          });
        }
      });

      return result;
    };

    // If result exists, process the month data; otherwise, return an empty array
    return result.length > 0 ? processMonthData(result) : [];
  }
}
