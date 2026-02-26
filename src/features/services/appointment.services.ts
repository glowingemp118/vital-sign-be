import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose'; // Assuming you have a Doctor model
import moment from 'moment-timezone'; // For handling timezones
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
  statusCounts,
} from '../../utils/dbUtils';
import { UserType } from '../../user/dto/user.dto';
import { Review } from '../schemas/reviews.schema';
import { NotificationService } from 'src/notification/notification.service';
import {
  NOTIFICATION_CONFIG,
  NOTIFICATION_TYPE,
} from 'src/constants/constants';

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectModel(Appointment.name) private appointmentModel: Model<Appointment>,
    @InjectModel(Doctor.name) private doctorModel: Model<Doctor>,
    @InjectModel(Review.name) private reviewModel: Model<Review>,
    private readonly notificationService: NotificationService,
  ) {}

  // Function to get available slots for a specific doctor, date, and dynamic duration
  async getAvailableSlots(user: any, body: any) {
    try {
      const { date, doctor: drId, duration, unit } = body;
      const userTimezone = user?.timezone;
      if (!date || !drId || !duration) {
        throw new Error('date, doctor, duration are required');
      }
      const doctor = await this.doctorModel
        .findOne({ user: new mongoose.Types.ObjectId(drId) })
        .exec();
      if (!doctor) {
        throw new Error('Doctor not found');
      }

      // Adjust date for user's timezone
      const requestedDate = moment.tz(date, userTimezone).format('YYYY-MM-DD'); // Convert date to user's timezone
      const requestedDay = moment
        .tz(requestedDate, userTimezone)
        .format('dddd'); // Get the day of the week (e.g., "Monday")
      // Get the doctor's working hours for the specific day
      const workingDay = doctor.timing.find(
        (item) => item.day === requestedDay,
      );
      if (!workingDay || !workingDay.isOpen) {
        throw new Error(`Doctor is not available on ${requestedDay}`);
      }

      // Doctor's working hours
      const workStartTime = moment.tz(
        `${date} ${workingDay.open}`,
        userTimezone,
      );
      const workEndTime = moment.tz(
        `${date} ${workingDay.close}`,
        userTimezone,
      );

      // Use the current time to start calculating available slots
      let currentTime = moment.tz(userTimezone); // Current time in the user's timezone

      // If the current time is before the doctor's work start time, begin from the workStartTime
      if (currentTime.isBefore(workStartTime)) {
        currentTime = workStartTime; // If current time is before work start, use workStartTime
      }

      // Round current time to the nearest valid slot (e.g., nearest 30-minute increment)
      const roundToNearestSlot = (
        time: moment.Moment,
        slotDuration: number,
      ) => {
        const minutes = time.minute();
        const remainder = minutes % slotDuration;
        if (remainder === 0) {
          return time; // Already aligned with the slot
        } else {
          return time.add(slotDuration - remainder, 'minutes'); // Round to next valid slot
        }
      };

      // Adjust current time to the nearest valid 30-minute slot
      currentTime = roundToNearestSlot(currentTime, 30); // Adjust to nearest 30-minute increment

      // Convert duration to minutes if it's in hours
      let durationInMinutes = duration;
      if (unit === 'hours') {
        durationInMinutes = duration * 60; // Convert hours to minutes
      }

      // Get all appointments for the doctor on this date
      const bookedAppointments = await this.appointmentModel.find({
        doctor: new mongoose.Types.ObjectId(drId),
        // user: new mongoose.Types.ObjectId(user?._id),
        date: date,
        status: { $in: ['pending', 'confirmed'] },
      });

      // console.log(bookedAppointments, 'booked');

      const availableSlots = [];

      // Iterate through each time slot within the doctor's working hours
      while (currentTime.isBefore(workEndTime)) {
        // Calculate the end time of the slot
        const slotEndTime = currentTime
          .clone()
          .add(durationInMinutes, 'minutes');

        // Check if this slot is already booked by comparing start and end times
        const isSlotBooked = bookedAppointments.some((appointment) => {
          // Convert the appointment's start and end times to moment objects
          const appointmentStartTime = appointment.startTime; // Assuming this is in 'HH:mm' format
          const appointmentEndTime = appointment.endTime;

          const currentSlotStart = currentTime.format('HH:mm'); // Format current time to 'HH:mm'
          const currentSlotEnd = slotEndTime.format('HH:mm');
          const appointmentDate = moment
            .tz(appointment.date, userTimezone)
            .format('YYYY-MM-DD'); // Convert appointment date to user's timezone and format

          // Return true if the current slot overlaps with any booked appointments

          return (
            currentSlotStart === appointmentStartTime && // Compare start time
            currentSlotEnd === appointmentEndTime &&
            appointmentDate === requestedDate // Ensure the date matches
          );
        });

        // If not booked, add to available slots
        if (!isSlotBooked) {
          availableSlots.push({
            start: currentTime.format('HH:mm'),
            end: slotEndTime.format('HH:mm'),
          });
        }

        // Move to the next slot (30 minutes later)
        currentTime = currentTime.add(durationInMinutes, 'minutes'); // Move by 30-minute increments
      }

      return availableSlots;
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async createAppointment(user: any, body: any) {
    try {
      const { doctor, startTime, endTime, date, unit, duration, notes } = body;

      validateParams(this.appointmentModel.schema, body, {
        requiredFields: [
          'doctor',
          'startTime',
          'endTime',
          'date',
          'duration',
          'notes',
        ],
        allowExtraFields: true,
      });

      const doctorExists: any = await this.doctorModel
        .findOne({ user: new mongoose.Types.ObjectId(doctor) })
        .populate({ path: 'user', select: 'name email' })
        .exec();
      if (!doctorExists) {
        throw new Error('Doctor not found');
      }
      const slots = await this.getAvailableSlots(user, {
        date,
        doctor,
        duration,
        unit,
      });
      if (
        slots.length == 0 ||
        !slots?.some((v) => v.start == startTime || v.end == endTime)
      ) {
        throw new Error('Invalid slot or already booked');
      }
      const appointmentId = `VSA-${Math.floor(1000 + Math.random() * 9000)}`;
      // Create a new appointment document
      const newAppointment = new this.appointmentModel({
        appointmentId,
        user: new mongoose.Types.ObjectId(user?._id),
        doctor: new mongoose.Types.ObjectId(doctor),
        date,
        startTime,
        endTime,
        duration,
        unit,
        notes: notes && processValue(notes, 'encrypt'),
      });

      // Save the appointment to the database
      await newAppointment.save();
      const sndNotification = async () => {
        try {
          const mdate = moment.tz(date, user?.timezone || 'UTC').format('ll');
          const msg = `Your appointment ${appointmentId} on ${mdate} from ${startTime} to ${endTime} has been booked successfully.`;
          const notify = NOTIFICATION_CONFIG[NOTIFICATION_TYPE.APPOINTMENT_NEW];
          await Promise.all(
            [user?._id, doctorExists.user?._id].map((userId) =>
              this.notificationService.sendNotification({
                userId,
                title: notify.title,
                message: msg,
                type: notify.type,
                object: { appointmentId: newAppointment._id?.toString() },
              }),
            ),
          );
        } catch (error) {
          console.error(
            'Error in background task for sending appointment notification:',
            error,
          );
        }
      };
      await sndNotification();
      return newAppointment;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async getAllAppointments(user: any, query: any) {
    const {
      pageno,
      limit,
      search,
      status,
      order = 'sort',
      patience,
      dr,
      filter = {},
    } = query;
    const { _id, user_type } = user;
    let obj: any = { ...filter };
    try {
      const timezone = user?.timezone || 'UTC';
      const isAdmin = user_type == UserType.Admin;
      if (user_type == UserType.User) {
        obj.user = new mongoose.Types.ObjectId(_id);
      } else if (user_type == UserType.Doctor) {
        obj.doctor = new mongoose.Types.ObjectId(_id);
      } else if (isAdmin) {
        if (patience) {
          obj.user = new mongoose.Types.ObjectId(patience);
        } else if (dr) {
          obj.doctor = new mongoose.Types.ObjectId(dr);
        }
      }
      await this.updateExpiredAppointments(user, obj);
      if (status && status !== 'all') {
        obj.status = status;
      }
      const pipeline: any[] = [{ $match: obj }]; // Match the filter
      pipeline.push(...appointmentPipeline());
      if (order) {
        pipeline.push({ $sort: { date: 1 } });
      }
      const queryFields = {
        'user.hashes': ['email', 'phone', 'name'],
        'doctor.user': ['email', 'phone', 'name'],
        'doctor.specialties': ['title', 'description'],
      };

      const projectFields = {
        'user.hashes': 0,
        'doctor.user.hashes': 0,
      };
      if (search) {
        pipeline.push(...searchPipeline(search, queryFields));
      }
      pipeline.push({ $project: projectFields });
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.appointmentModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
      let count = {};
      const { status: s, ...restFilter } = obj;
      if (isAdmin || user_type == UserType.Doctor) {
        const [countResult] = await this.appointmentModel.aggregate(
          statusCounts(
            ['pending', 'confirmed', 'cancelled', 'expired', 'completed'],
            restFilter,
          ),
        );
        count = countResult;
      }
      return {
        meta: { ...result?.meta, ...count },
        data: result?.data?.map((a: any) => {
          return {
            ...a,
            user: processObject(a.user, 'decrypt'),
            notes: processValue(a.notes, 'decrypt'),
          };
        }),
      };
    } catch (err) {
      console.error('Error fetching appointments:', err);
      throw new BadRequestException(
        err?.message || 'Error fetching appointments',
      );
    }
  }

  async updateAppointmentStatus(req: any) {
    try {
      const { status, reason } = req?.body;
      if (status == 'cancelled' && !reason) {
        throw new Error('Reason is required for cancelling an appointment');
      }
      const id = new mongoose.Types.ObjectId(req?.params?.id);
      const { _id, user_type } = req.user;
      if (!status || status == 'pending') {
        throw new Error('status is required or invalid');
      }
      let obj: any = { _id: id };
      if (user_type == UserType.User) {
        obj.user = new mongoose.Types.ObjectId(_id);
      } else if (user_type == UserType.Doctor) {
        obj.doctor = new mongoose.Types.ObjectId(_id);
      }
      // Find the existing appointment
      const existingAppointment = await this.appointmentModel.findOne(obj);

      if (!existingAppointment) {
        throw new Error('Appointment not found or unauthorized to update');
      }

      if (existingAppointment.status == status) {
        throw new Error(`Already ${status}`);
      }
      // Update the status of the appointment

      if (status == 'cancelled') {
        if (existingAppointment.status !== 'pending') {
          throw new Error('Only pending appointments can be cancelled');
        }
        existingAppointment.cancelled = {
          reason: reason,
          cancelledAt: new Date(),
          cancelledBy: _id,
        };
      }
      existingAppointment.status = status;
      // Save the updated appointment document
      existingAppointment.save();
      const sndNotification = async () => {
        try {
          const { appointmentId, date, startTime, endTime } =
            existingAppointment || {};
          const mdate = moment
            .tz(date, req?.user?.timezone || 'UTC')
            .format('ll');
          const msg = `Your appointment ${appointmentId} on ${mdate} from ${startTime} to ${endTime} has been ${status} successfully.`;
          await Promise.all(
            [existingAppointment.user, existingAppointment.doctor].map(
              (userId) =>
                this.notificationService.sendNotification({
                  userId: userId,
                  title: `Appointment ${status}`,
                  message: msg,
                  type: `appointment_${status}`,
                  object: {
                    appointmentId: existingAppointment._id?.toString(),
                  },
                }),
            ),
          );
        } catch (error) {
          console.error(
            'Error in background task for sending appointment notification:',
            error,
          );
        }
      };
      await sndNotification();
      return existingAppointment;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async getAppointmentById(user: any, appointmentId: string) {
    try {
      const isAdmin = user?.user_type == UserType.Admin;
      // Validate appointmentId
      if (!appointmentId) {
        throw new Error('Appointment ID is required');
      }

      const filter = {
        _id: new mongoose.Types.ObjectId(appointmentId),
      };
      const appointments: any = await this.getAllAppointments(user, { filter });
      const appointment = appointments?.data && appointments?.data[0];
      if (!appointment) {
        throw new Error(
          'Appointment not found or you do not have permission to view this appointment',
        );
      }
      const review = await this.reviewModel
        .findOne({
          appointment: new mongoose.Types.ObjectId(appointmentId),
        })
        .lean();
      if (review) {
        appointment.review = review;
      }
      return appointment;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async addReviewToAppointment(req: any) {
    try {
      const { rating, review } = req?.body;
      const appointmentId = new mongoose.Types.ObjectId(req?.params?.id);
      const uid = new mongoose.Types.ObjectId(req?.user?._id);
      // Basic validation
      if (!rating || rating < 1 || rating > 5 || !review.trim()) {
        throw new Error('Invalid rating or review');
      }

      // Find the appointment
      const appointment = await this.appointmentModel.findOne({
        _id: appointmentId,
        user: uid,
      });
      if (!appointment) throw new Error('Appointment not found');
      if (appointment.status !== 'completed')
        throw new Error('Appointment not completed yet');
      // Check if the user has already reviewed the doctor
      const existingReview = await this.reviewModel.findOne({
        appointment: appointmentId,
        user: uid,
        doctor: appointment.doctor,
      });
      if (existingReview)
        throw new Error('You have already reviewed this appointment');

      // Create and save the review
      const newReview = new this.reviewModel({
        appointment: appointmentId,
        user: uid,
        rating,
        review,
        doctor: appointment.doctor,
      });

      await newReview.save();
      return newReview;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async updateReviewForAppointment(req: any) {
    try {
      const { rating, review } = req?.body;
      const appointmentId = new mongoose.Types.ObjectId(req?.params?.id);
      const uid = new mongoose.Types.ObjectId(req?.user?._id);

      // Basic validation for rating and review
      if ((!rating || rating < 1 || rating > 5) && !review) {
        throw new Error('Invalid rating or review');
      }
      // Find the existing review by appointment and user
      const existingReview = await this.reviewModel.findOne({
        appointment: appointmentId,
        user: uid,
      });

      if (!existingReview) {
        throw new Error('Review not found or unauthorized');
      }

      // Update the review fields
      if (rating) {
        existingReview.rating = rating;
      }
      if (review) {
        existingReview.review = review?.trim();
      }
      // Save the updated review
      await existingReview.save();

      return existingReview;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async removeReviewFromAppointment(req: any) {
    try {
      const appointmentId = new mongoose.Types.ObjectId(req?.params?.id);
      const uid = new mongoose.Types.ObjectId(req?.user?._id);

      // Find the review by appointment and user
      const review = await this.reviewModel.findOne({
        appointment: appointmentId,
        user: uid,
      });

      if (!review) {
        throw new Error('Review not found or unauthorized');
      }

      // Remove the review
      await this.reviewModel.deleteOne({
        appointment: appointmentId,
        user: uid,
      });

      return { message: 'Review removed successfully' };
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async updateExpiredAppointments(user: any, cond: any) {
    const userTimezone = user?.timezone || 'UTC';
    const now = moment.tz(userTimezone); // Current time in user's timezone
    const todayDate = now.format('YYYY-MM-DD'); // Today's date in 'YYYY-MM-DD' format for the user's timezone
    // Update the logic for handling string start and end times
    await this.appointmentModel.updateMany(
      {
        ...cond,
        status: 'pending', // Ensure status is 'pending'
        date: { $lte: now.toDate() }, // Appointment date is today or earlier
        $or: [
          // Expired if the current time is after the appointment's endTime
          {
            $expr: {
              $lt: [
                { $concat: [todayDate, 'T', '$endTime', ':00.000Z'] },
                now.toISOString(),
              ],
            },
          },
          // Appointment is ongoing or expired if it's finished
          {
            $expr: {
              $and: [
                {
                  $lte: [
                    { $concat: [todayDate, 'T', '$startTime', ':00.000Z'] },
                    now.toISOString(),
                  ],
                },
                {
                  $gte: [
                    { $concat: [todayDate, 'T', '$endTime', ':00.000Z'] },
                    now.toISOString(),
                  ],
                },
              ],
            },
          },
        ],
      },
      { $set: { status: 'expired' } }, // Update the status to 'expired'
    );
  }

  validateAppointment({ user, date, startTime, endTime }: any) {
    const now = moment.tz(user?.timezone || 'UTC'); // Current time in user's timezone
    const appointmentDateTime = moment.tz(
      date,
      'YYYY-MM-DD',
      user?.timezone || 'UTC',
    ); // Appointment date in user's timezone

    // Create moment objects for start and end times
    const startDateTime = moment.tz(
      appointmentDateTime.format('YYYY-MM-DD') + 'T' + startTime,
      user?.timezone || 'UTC',
    );
    const endDateTime = moment.tz(
      appointmentDateTime.format('YYYY-MM-DD') + 'T' + endTime,
      user?.timezone || 'UTC',
    );

    // Check if the appointment date, start, and end are today or in the future
    if (now.isAfter(appointmentDateTime)) {
      return {
        valid: false,
        message: 'Appointment date must be today or in the future.',
      };
    }

    if (now.isAfter(startDateTime)) {
      return {
        valid: false,
        message: 'Appointment start time must be in the future.',
      };
    }

    if (now.isAfter(endDateTime)) {
      return {
        valid: false,
        message: 'Appointment end time must be in the future.',
      };
    }

    // If all checks pass
    return { valid: true, message: 'Appointment is valid.' };
  }
}
