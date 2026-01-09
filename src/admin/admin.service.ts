// src/services/admin.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Settings,
  SettingsDocument,
  Faq,
  FaqDocument,
  ContactSupportDocument,
  ContactSupport,
} from './schemas/admin.schema';
import { Speciality, SpecialityDocument } from './schemas/speciality.schema';
import { User, UserDocument } from 'src/user/schemas/user.schema';
import * as bcrypt from 'bcrypt';
import { generateToken } from 'src/guards/auth.guard';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import { UserType } from 'src/user/dto/user.dto';
import { Doctor, DoctorDocument } from 'src/user/schemas/doctor.schema';
import { processObject } from 'src/utils/encrptdecrpt';
import { addDr } from 'src/utils/appUtils';
import { pipeline } from 'stream';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(Settings.name) private settingsModel: Model<SettingsDocument>,
    @InjectModel(Faq.name) private faqModel: Model<FaqDocument>,
    @InjectModel(ContactSupport.name)
    private contactSupportModel: Model<ContactSupportDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Speciality.name)
    private specialityModel: Model<SpecialityDocument>,
    @InjectModel(Doctor.name) private doctorModel: Model<DoctorDocument>,
  ) {}

  //login
  //login
  async signIn(signInDto: any) {
    const user = await this.userModel
      .findOne({ email: signInDto.email })
      .exec();

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.user_type !== UserType.Admin) {
      throw new UnauthorizedException('Access denied');
    }

    const isPasswordValid = await bcrypt.compare(
      signInDto.password,
      user.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid password');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`);
    }

    if (!user.is_verified) {
      throw new UnauthorizedException('Email is not verified');
    }
    const token_res = generateToken(user);
    return {
      user,
      token_res,
    };
  }

  // Settings Methods
  async getSettings(field: string) {
    return this.settingsModel.findOne({}, { _id: 0, [field]: 1 }).exec();
  }

  async saveSettings(field: string, value: string) {
    let settings = await this.settingsModel.findOne({});
    if (!settings) {
      settings = new this.settingsModel({ about: '', privacy: '', tac: '' });
    }
    settings[field] = value;
    const savedSettings = await settings.save();
    return { [field]: savedSettings[field] };
  }

  // FAQ Methods
  async createFaq(question: string, answer: string) {
    const faq = new this.faqModel({ question, answer });
    return faq.save();
  }

  async updateFaq(id: string, question: string, answer: string) {
    return this.faqModel
      .findByIdAndUpdate(id, { question, answer }, { new: true })
      .exec();
  }

  async deleteFaq(id: string) {
    return this.faqModel.findByIdAndDelete(id).exec();
  }

  async getAllFaqs(query: any) {
    const { pageno, limit, search } = query;
    let obj: any = {};
    try {
      if (search) {
        obj['$or'] = [{ question: { $regex: search, $options: 'i' } }]; // Searching by question
      }
      const pipeline: any[] = [{ $match: obj }]; // Match the filter
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.faqModel.aggregate(pipeline); // Using the Faq model to aggregate
      const result = finalRes({ pageno, limit, data });
      return result;
    } catch (err) {
      return finalRes({ pageno, limit, data: [] });
    }
  }

  // Create a new request
  async createRequest(data: {
    email: string;
    name: string;
    subject: string;
    message: string;
  }) {
    // Check for existing request with same subject and email, and status not 'closed'
    const existingRequest = await this.contactSupportModel.findOne({
      email: data.email,
      subject: data.subject,
      status: { $ne: 'closed' },
    });

    if (existingRequest) {
      // Update existing request: push new message to replies
      existingRequest.replies.push('User: ' + data.message);
      existingRequest.updatedAt = new Date();
      await existingRequest.save();
      return existingRequest;
    } else {
      // Create new request
      const request = await this.contactSupportModel.create({
        email: data.email,
        name: data.name,
        subject: data.subject,
        message: data.message,
        replies: ['User: ' + data.message],
        status: 'pending',
        updatedAt: new Date(),
      });
      return request;
    }
  }

  // Update a request with replies and status
  async updateRequest(id: string, update: { reply?: string; status?: string }) {
    const updateData: any = {};
    if (update.reply) {
      // Push new reply to the replies array
      return this.contactSupportModel.findOneAndUpdate(
        { _id: new (require('mongoose').Types.ObjectId)(id) },
        {
          $push: { replies: 'Admin: ' + update.reply },
          ...(update.status && {
            $set: { status: update.status, updatedAt: new Date() },
          }),
        },
        { new: true },
      );
    } else if (update.status) {
      // Only update status
      return this.contactSupportModel.findOneAndUpdate(
        { _id: new (require('mongoose').Types.ObjectId)(id) },
        { $set: { status: update.status, updatedAt: new Date() } },
        { new: true },
      );
    }
    // If neither reply nor status is provided, just update updatedAt
    return this.contactSupportModel.findOneAndUpdate(
      { _id: new (require('mongoose').Types.ObjectId)(id) },
      { $set: { updatedAt: new Date() } },
      { new: true },
    );
  }

  // Delete a request
  async deleteRequest(id: string) {
    return this.contactSupportModel.findByIdAndDelete(id).exec();
  }

  // Get all requests
  async getRequests(query: any) {
    const { pageno, limit, search } = query;
    let obj: any = {};
    try {
      if (search) {
        obj['$or'] = [{ subject: { $regex: search, $options: 'i' } }];
        obj['$or'] = [{ email: { $regex: search, $options: 'i' } }];
        obj['$or'] = [{ name: { $regex: search, $options: 'i' } }];
      }
      const pipeline: any[] = [{ $match: obj }]; // Match the filter
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.contactSupportModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
      return result;
    } catch (err) {
      return finalRes({ pageno, limit, data: [] });
    }
  }

  // Doctor

  async addDoctor(body: {
    name: string;
    email: string;
    password: string;
    country?: string;
    gender?: string;
    phone?: string;
    specialty: string;
    experience: string;
    about?: string;
  }) {
    const { email, password, name, phone, country, gender } = body;

    // Check if email already exists
    const existingUser = await this.userModel.findOne({ email });
    if (existingUser) {
      throw new UnauthorizedException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    // const encryted_obj = processObject({ name, email, phone }, 'encrypt');
    // const hash_obj = processObject({ name, email, phone }, 'hash');

    let user: any = new this.userModel({
      password: hashedPassword,
      user_type: UserType.Doctor,
      is_verified: true,
      name,
      phone,
      country,
      gender,
      // ...encryted_obj,
      // hashes: { ...hash_obj },
    });

    await user.save();
    if (user) {
      user = user.toObject();
      user.doctor = await addDr(user, body, {
        specialty: this.specialityModel,
        dr: this.doctorModel,
      });
    }
    return { ...user };
  }

  // Specialty Methods

  async addSpecialty(body: {
    title: string;
    description: string;
    image?: string;
  }) {
    const { title, description, image } = body;
    const specialty = new this.specialityModel({ title, description, image });
    return specialty.save();
  }

  async updateSpecialty(
    id: string,
    update: { title?: string; description?: string; image?: string },
  ) {
    return this.specialityModel
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
  }

  async getSpecialtyById(id: string) {
    return this.specialityModel.findById(id).exec();
  }

  async getAllSpecialties(query: any) {
    const { pageno, limit, search } = query;
    let obj: any = {};
    try {
      if (search) {
        obj['$or'] = [{ title: { $regex: search, $options: 'i' } }];
        obj['$or'] = [{ description: { $regex: search, $options: 'i' } }];
      }
      obj = search
        ? {
            $or: [
              { title: { $regex: search, $options: 'i' } },
              { description: { $regex: search, $options: 'i' } },
            ],
          }
        : {};
      const pipeline: any[] = [
        { $match: obj },
        {
          $lookup: {
            from: 'doctors',
            localField: '_id',
            foreignField: 'specialties',
            as: 'doctors',
          },
        },
        {
          $addFields: {
            doctorCount: { $size: '$doctors' },
          },
        },
        {
          $project: {
            doctors: 0,
          },
        },
      ];
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.specialityModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
      return result;
    } catch (err) {
      return finalRes({ pageno, limit, data: [] });
    }
  }

  async deleteSpecialty(id: string) {
    return this.specialityModel.findByIdAndDelete(id).exec();
  }
}
