import { NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model, Types } from 'mongoose';
import { Voice } from 'src/health-voice/schemas/voice.schema';
import { UserType } from 'src/user/dto/user.dto';
import { User } from 'src/user/schemas/user.schema';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import { validateParams } from 'src/utils/validations';
import { Transcription } from '../schemas/transcription.schema';
import { processObject, processValue } from 'src/utils/encrptdecrpt';

export class TranscriptionService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Voice.name) private voiceModel: Model<Voice>,
    @InjectModel(Transcription.name)
    private transcriptionModel: Model<Transcription>,
  ) {}

  async createTranscription(req: any) {
    const uid = new mongoose.Types.ObjectId(req?.user?._id);

    const body = req.body;

    validateParams(this.transcriptionModel.schema, body, {
      requiredFields: ['doctor', 'voice'],
      allowExtraFields: true,
    });

    let { doctor, voice } = body;

    const isDoctorExist = await this.userModel.findOne({
      _id: new mongoose.Types.ObjectId(doctor),
      user_type: UserType.Doctor,
    });

    if (!isDoctorExist) {
      throw new Error('Doctor does not exist');
    }

    const isVoiceExist = await this.voiceModel.findOne({ _id: voice });

    if (!isVoiceExist) {
      throw new Error('Voice does not exist');
    }

    const transcription = new this.transcriptionModel({
      doctor: new mongoose.Types.ObjectId(doctor),
      voice: new mongoose.Types.ObjectId(voice),
      user: uid,
    });

    return await transcription.save();
  }

  async updateTranscription(req: any) {
    const { id } = req.params;
    const { doctorRecommendation } = req.body;
    if (!doctorRecommendation) {
      throw new Error('Doctor recommendation is required');
    }
    let transcription ;

    transcription= await this.transcriptionModel.findById(id);

    if(!transcription){
      transcription= await this.transcriptionModel.findOne({voice:new mongoose.Types.ObjectId(id)});
    }

    if (!transcription) {
      throw new Error('Transcription not found');
    }

    transcription.doctorRecommendation = doctorRecommendation;

    return await transcription.save();
  }

  async getTranscription(query: any) {
    try {
      const user = query.user;

      let { pageno, limit, search } = query;

      const pipeline = [];

      if (query.user?.user_type === UserType.User) {
        pipeline.push({
          $match: {
            user: new mongoose.Types.ObjectId(user?._id),
          },
        });
      }

      if (query.user?.user_type === UserType.Doctor) {
        pipeline.push({
          $match: {
            doctor: new mongoose.Types.ObjectId(user?._id),
          },
        });
      }

      pipeline.push({
        $lookup: {
          from: 'voices',
          let: { id: '$voice' },
          as: 'voice',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
          ],
        },
      });

      pipeline.push({
        $lookup: {
          from: 'users',
          let: { id: '$doctor' },
          as: 'doctor',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                email: 1,
                image: { $concat: [process.env.IB_URL || '', '$image'] },
              },
            },
            {
              $lookup: {
                from: 'doctors',
                let: { id: '$_id' },
                as: 'doctorInfo',
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: ['$user', '$$id'],
                      },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      specialties: 1,
                    },
                  },
                ],
              },
            },
            {
              $unwind: {
                path: '$doctorInfo',
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $addFields: {
                specialties: '$doctorInfo.specialties',
              },
            },
            {
              $addFields: {
                specialtyIds: {
                  $map: {
                    input: '$specialties',
                    as: 'id',
                    in: { $toObjectId: '$$id' },
                  },
                },
              },
            },
            {
              $lookup: {
                from: 'specialities',
                let: { id: '$specialtyIds' },
                as: 'specialties',
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $in: ['$_id', '$$id'],
                      },
                    },
                  },
                  {
                    $project: {
                      title: 1,
                      description: 1,
                    },
                  },
                ],
              },
            },
            {
              $project: {
                doctorInfo: 0,
                specialtyIds: 0,
              },
            },
          ],
        },
      });

      pipeline.push({
        $lookup: {
          from: 'users',
          let: { id: '$user' },
          as: 'user',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
            {
              $project: {
                name: 1,
                email: 1,
                image: { $concat: [process.env.IB_URL || '', '$image'] },
                hashes: 1,
              },
            },
          ],
        },
      });

      pipeline.push({
        $unwind: {
          path: '$voice',
        },
      });

      pipeline.push({
        $unwind: {
          path: '$doctor',
        },
      });
      pipeline.push({
        $unwind: {
          path: '$user',
        },
      });

      if (search) {
        const hashSearch = processValue(search, 'hash');
        pipeline.push({
          $match: {
            $or: [
              { 'doctor.name': { $regex: `.*${search}.*`, $options: 'i' } },
              { 'doctor.email': { $regex: `.*${search}.*`, $options: 'i' } },
              { 'user.hashes.name': { $regex: hashSearch, $options: 'i' } },
              { 'user.hashes.email': { $regex: hashSearch, $options: 'i' } },
              {
                'voice.transcription': {
                  $regex: `.*${search}.*`,
                  $options: 'i',
                },
              },
              {
                'voice.latestSummary.summary.riskPatterns': {
                  $regex: search,
                  $options: 'i',
                },
              },
            ],
          },
        });
      }
         pipeline.push({
        $sort: {
          createdAt: -1
        }
      });

      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination

      const data = await this.transcriptionModel.aggregate(pipeline);

      const result = finalRes({ pageno, limit, data });

      return {
        data: result?.data?.map((r: any) => {
          delete r?.user.hashes;
          return {
            ...r,
            user: processObject(r.user, 'decrypt'),
          };
        }),
        meta: { ...result?.meta },
      };
    } catch (error) {
      console.log('error', error);
      throw new NotFoundException('No requests found');
    }
  }

  async getTranscriptionBy(req: any) {
    try {
      const _id = req.params.id;

      const pipeline = [];

      pipeline.push({
        $match: {
          $or: [
            { _id: new mongoose.Types.ObjectId(_id) },
            { voice: new mongoose.Types.ObjectId(_id) },
          ],
        },
      });

      pipeline.push({
        $lookup: {
          from: 'voices',
          let: { id: '$voice' },
          as: 'voice',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
          ],
        },
      });

      pipeline.push({
        $lookup: {
          from: 'users',
          let: { id: '$doctor' },
          as: 'doctor',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                email: 1,
                image: { $concat: [process.env.IB_URL || '', '$image'] },
              },
            },
            {
              $lookup: {
                from: 'doctors',
                let: { id: '$_id' },
                as: 'doctorInfo',
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: ['$user', '$$id'],
                      },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      specialties: 1,
                    },
                  },
                ],
              },
            },
            {
              $unwind: {
                path: '$doctorInfo',
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $addFields: {
                specialties: '$doctorInfo.specialties',
              },
            },
            {
              $addFields: {
                specialtyIds: {
                  $map: {
                    input: '$specialties',
                    as: 'id',
                    in: { $toObjectId: '$$id' },
                  },
                },
              },
            },
            {
              $lookup: {
                from: 'specialities',
                let: { id: '$specialtyIds' },
                as: 'specialties',
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $in: ['$_id', '$$id'],
                      },
                    },
                  },
                  {
                    $project: {
                      title: 1,
                      description: 1,
                    },
                  },
                ],
              },
            },
            {
              $project: {
                doctorInfo: 0,
                specialtyIds: 0,
              },
            },
          ],
        },
      });

      pipeline.push({
        $lookup: {
          from: 'users',
          let: { id: '$user' },
          as: 'user',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$id'],
                },
              },
            },
            {
              $project: {
                name: 1,
                email: 1,
                image: { $concat: [process.env.IB_URL || '', '$image'] },
                hashes: 1,
              },
            },
          ],
        },
      });

      pipeline.push({
        $unwind: {
          path: '$voice',
        },
      });

      pipeline.push({
        $unwind: {
          path: '$doctor',
        },
      });
      pipeline.push({
        $unwind: {
          path: '$user',
        },
      });

      let data = await this.transcriptionModel.aggregate(pipeline);

      data = data?.map((r: any) => {
        delete r?.user.hashes;
        return {
          ...r,
          user: processObject(r.user, 'decrypt'),
        };
      });

      return data[0];
    } catch (error) {
      console.log('error', error);
      throw new NotFoundException('No requests found');
    }
  }
}
