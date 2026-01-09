import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose'; // Assuming you have a Doctor model
import { Doctor } from 'src/user/schemas/doctor.schema';
import { validateParams } from 'src/utils/validations';
import { processObject } from 'src/utils/encrptdecrpt';
import {
  finalRes,
  paginationPipeline,
  reviewsRating,
  searchPipeline,
  sort,
  specialitiesPipeline,
  userPipeline,
} from 'src/utils/dbUtils';
import { Review } from '../schemas/reviews.schema';
@Injectable()
export class FeatureService {
  constructor(
    @InjectModel(Doctor.name) private doctorModel: Model<Doctor>,
    @InjectModel(Review.name) private reviewModel: Model<Review>,
  ) {}
  async getDoctors(req: any) {
    try {
      const { pageno, limit, search, filter = {} } = req.query;
      const pipeline: any[] = [
        { $match: { ...filter } },
        ...userPipeline(),
        ...specialitiesPipeline(),
        ...reviewsRating('user._id'),
        sort(),
        { $project: { timing: 0, __v: 0, reviews: 0 } },
      ];
      const queryFields = {
        user: ['email', 'phone', 'name'],
        specialties: ['title', 'description'],
      };
      if (search) {
        pipeline.push(...searchPipeline(search, queryFields));
      }
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit }));
      const data = await this.doctorModel.aggregate(pipeline);
      const result = finalRes({ pageno, limit, data });

      return {
        ...result,
        data: result.data?.map((a: any) => ({
          ...a,
          user: a?.user ? processObject(a?.user, 'decrypt') : a?.user,
        })),
      };
    } catch (err) {
      throw new BadRequestException(err?.message);
    }
  }

  async getDoctorById(req: any) {
    try {
      const uid = new mongoose.Types.ObjectId(req.params.id);
      const { user } = req;
      // Validate appointmentId
      if (!uid) {
        throw new Error('Doctor ID is required');
      }

      const filter = {
        user: new mongoose.Types.ObjectId(uid),
      };
      const drs: any = await this.getDoctors({
        query: { filter },
        user,
      });
      const dr = drs?.data && drs?.data[0];
      if (!dr) {
        throw new Error(
          'Doctor not found or you do not have permission to view this doctor',
        );
      }

      return dr;
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }

  async getDrReviews(req: any) {
    try {
      const uid = new mongoose.Types.ObjectId(req.params.id);
      if (!uid) {
        throw new Error('Doctor ID is required');
      }
      const { pageno, limit } = req.query;
      const filter = { doctor: uid };
      const pipeline: any[] = [
        { $match: { ...filter } },
        ...userPipeline(),
        sort(),
        { $project: { __v: 0, 'user.hashes': 0 } },
      ];
      const data = await this.reviewModel.aggregate(pipeline);
      const result = finalRes({ pageno, limit, data });
      return {
        ...result,
        data: result.data?.map((a: any) => ({
          ...a,
          user: a?.user ? processObject(a?.user, 'decrypt') : a?.user,
        })),
      };
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }
}
