import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import {
  SignInDto,
  CreateUserDto,
  UpdateUserDto,
  UserType,
} from './dto/user.dto';
import * as bcrypt from 'bcrypt';
import { generateToken, validateRefreshToken } from '../guards/auth.guard';
import { addDr, modifiedUser } from '../utils/appUtils';
import { validateParams } from '../utils/validations';
import { Doctor } from './schemas/doctor.schema';
import { Speciality } from '../admin/schemas/speciality.schema';
import { Device, DevicesDocument } from './schemas/devices.schema';
import { processObject, processValue } from '../utils/encrptdecrpt';
import {
  countAlerts,
  countStat,
  finalRes,
  paginationPipeline,
  statusCounts,
} from 'src/utils/dbUtils';
import { Appointment } from 'src/features/schemas/appointments.schema';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Device.name) private deviceModel: Model<DevicesDocument>,
    @InjectModel(Doctor.name) private doctorModel: Model<any>,
    @InjectModel(Speciality.name) private specialityModel: Model<any>,
    @InjectModel(Appointment.name) private appointmentModel: Model<any>,
  ) {}
  generateOtp = () => {
    return Math.floor(100000 + Math.random() * 900000).toString(); // Generate OTP
  };
  expiryTime = () => {
    return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now
  };
  // Create user and save it to the database
  async createUser(dto: CreateUserDto): Promise<any> {
    try {
      let { name, email, phone, password, user_type, timezone } = dto;
      email = email ? email.toLowerCase().trim() : ''; // Ensure email is defined
      if (user_type === UserType.Doctor) {
        validateParams(this.doctorModel.schema, dto, {
          requiredFields: ['specialties', 'experience'],
          allowExtraFields: true,
        });
      }
      const isExistingUser = await this.findUserByEmail(email);
      if (
        isExistingUser &&
        isExistingUser?.status == 'active' &&
        isExistingUser?.is_verified
      ) {
        throw new UnauthorizedException('User already exists');
      }
      if (isExistingUser && isExistingUser?.status !== 'active') {
        throw new UnauthorizedException(
          `User account status is ${isExistingUser.status}`,
        );
      }

      password = await bcrypt.hash(password, 10);
      const isUser = user_type === UserType.User;
      const encryted_obj = processObject({ name, email, phone }, 'encrypt');
      const hash_obj = processObject({ name, email, phone }, 'hash');

      const userData: any = {
        ...dto,
        email,
        password: password,
        otp: this.generateOtp(),
        roles: [user_type],
        timezone: timezone || 'UTC',
        ...(isUser ? { ...encryted_obj, hashes: { ...hash_obj } } : {}),
      };
      const user = isExistingUser
        ? Object.assign(isExistingUser, userData)
        : new this.userModel(userData);

      let savedUser: any = await user.save();
      if (dto?.device_id && dto?.device_type) {
        await this.upsertDevice(savedUser._id, dto.device_id, dto.device_type);
      }
      if (user_type === UserType.Doctor) {
        savedUser = savedUser.toObject();
        savedUser.doctor = await addDr(user, dto, {
          specialty: this.specialityModel,
          dr: this.doctorModel,
        });
      }
      return {
        message: 'User created successfully',
        user: modifiedUser(savedUser),
      };
    } catch (error) {
      throw new UnauthorizedException(error?.message);
    }
  }

  // Find a user by email
  async findUserByEmail(email: string): Promise<UserDocument | null> {
    email = email.toLowerCase().trim();
    const hash_email = processValue(email, 'hash');
    const user = await this.userModel.findOne({
      $or: [{ 'hashes.email': hash_email }, { email: email }],
    });
    return user || null;
  }

  // Sign in a user and return a JWT token
  async signIn(signInDto: SignInDto) {
    try {
      let user: any = await this.findUserByEmail(signInDto.email);

      if (!user) {
        throw new UnauthorizedException('User not found');
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
      if (signInDto?.device_id && signInDto?.device_type) {
        await this.upsertDevice(
          user._id,
          signInDto.device_id,
          signInDto.device_type,
        );
      }
      const token_res = generateToken(user);
      if (user?.user_type == UserType.Doctor) {
        user = user.toObject();
        const doctor = await this.doctorModel
          .findOne({ user: user._id })
          .populate('specialties');
        user.doctor = doctor;
      }
      if (user?.timezone !== signInDto.timezone) {
        user.timezone = signInDto.timezone;
        await this.userModel.findByIdAndUpdate(user._id, {
          timezone: signInDto.timezone,
        });
      }
      return {
        user: modifiedUser(user),
        token_res,
      };
    } catch (error) {
      throw new UnauthorizedException(error?.message);
    }
  }

  // Update a user's profile
  async updateProfile(id: string, updateUserDto: UpdateUserDto): Promise<any> {
    // Find the user by ID and update
    const updatedUser = await this.userModel.findByIdAndUpdate(
      id,
      updateUserDto,
      { new: true },
    );
    if (!updatedUser) {
      throw new UnauthorizedException('User not found');
    }
    return { user: modifiedUser(updatedUser) };
  }

  // Delete a user by ID
  async deleteUser(id: string): Promise<void> {
    const user = await this.userModel.findByIdAndDelete(id);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
  }

  // Verify email using OTP
  async verifyOtp(email: string, otp: string, forgot_verify = false) {
    try {
      let user: any = await this.findUserByEmail(email);

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.expiry?.otp && user.expiry.otp < new Date()) {
        throw new UnauthorizedException('OTP has expired');
      }

      if (user.otp !== otp) {
        throw new UnauthorizedException('Invalid OTP');
      }

      user.is_verified = true;
      user.otp = null;
      if (forgot_verify) {
        user.expiry = {
          otp: null,
          reset: this.expiryTime(),
        };
      }
      await user.save(); // Save the updated user
      user = user.toObject();
      if (user?.user_type == UserType.Doctor) {
        const doctor = await this.doctorModel
          .findOne({ user: user._id })
          .populate('specialties');
        user.doctor = doctor;
      }

      const token_res = generateToken(user);
      return {
        user: modifiedUser(user),
        token_res,
      };
    } catch (error) {
      throw new UnauthorizedException(error?.message);
    }
  }

  // (send OTP)
  async sendOtp(email: string) {
    const user: any = await this.findUserByEmail(email);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const otp = this.generateOtp(); // Generate OTP
    user.otp = otp;
    user.expiry = { otp: this.expiryTime(), reset: null }; // Set OTP expiry to 15 minutes from now
    await user.save(); // Save the OTP to the user
    return { otp };
  }

  // Get user profile by ID
  async getProfile(id: string): Promise<any> {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return { user: modifiedUser(user) };
  }

  // Reset password using OTP
  async resetPassword(email: string, password: string) {
    const user = await this.findUserByEmail(email);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.expiry?.reset && user.expiry.reset < new Date()) {
      throw new UnauthorizedException('Reset token has expired');
    }
    if (!user.is_verified) {
      throw new UnauthorizedException('Email is not verified');
    }

    if (password.length < 6) {
      throw new UnauthorizedException(
        'Password must be at least 6 characters long',
      );
    }

    user.password = await bcrypt.hash(password, 10);
    user.otp = null;
    user.expiry = { otp: null, reset: null };
    await user.save(); // Save the updated password and remove OTP

    return { message: 'Password reset successfully' };
  }

  // Change password for a user
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Old password is incorrect');
    }
    if (oldPassword === newPassword) {
      throw new UnauthorizedException(
        'New password must be different from old password',
      );
    }

    if (newPassword.length < 6) {
      throw new UnauthorizedException(
        'Password must be at least 6 characters long',
      );
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { message: 'Password changed successfully' };
  }

  // Refresh JWT tokens using a valid refresh token
  async refreshToken(refreshToken: string) {
    try {
      // Replace with your actual JWT verification logic
      const payload = await validateRefreshToken(refreshToken);
      const user = await this.userModel.findById(payload?._id);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const token_res = generateToken(user, true);
      return {
        token_res,
      };
    } catch (err) {
      throw new UnauthorizedException(err?.message);
    }
  }

  // Add or update a device for a user
  async upsertDevice(user: string, device_id: string, device_type: string) {
    try {
      if (!user || !device_id || !device_type) {
        throw new UnauthorizedException('Invalid parameters for devices');
      }
      let devicesDoc: any = await this.deviceModel.findOne({ user });
      if (!devicesDoc) {
        // Create a new Devices document if not exists
        devicesDoc = new this.deviceModel({
          user: user,
          devices: [{ device_id: device_id, device_type: device_type }],
        });
      } else {
        // Find device index
        const idx = devicesDoc.devices.findIndex(
          (d: any) => d.device_id === device_id,
        );
        if (idx !== -1) {
          // Update deviceType if device exists
          devicesDoc.devices[idx].device_type = device_type;
        } else {
          // Add new device
          devicesDoc.devices.push({
            device_id: device_id,
            device_type: device_type,
          });
        }
      }

      await devicesDoc.save();
      return { devices: devicesDoc.devices };
    } catch (error) {
      throw new UnauthorizedException(error?.message);
    }
  }

  // // Logout: remove deviceId from user's devices
  async logout(userId: string, deviceId: string) {
    try {
      if (!deviceId) {
        throw new Error('Device ID is required for logout');
      }
      const devicesDoc: any = await this.deviceModel.findOne({ user: userId });
      if (devicesDoc) {
        devicesDoc.devices = devicesDoc.devices.filter(
          (device: any) => device.deviceId !== deviceId,
        );
        await devicesDoc.save();
      }

      return { message: 'Logged out successfully' };
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }
  // Soft delete a user by updating status to 'deleted'
  async softDeleteUser(userId: string) {
    try {
      const user = await this.userModel.findById(userId);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      if (user.status !== 'active' || !user.is_verified) {
        throw new UnauthorizedException(
          'User is not active or already deleted',
        );
      }
      await this.userModel.findByIdAndUpdate(
        userId,
        { status: 'deleted', is_verified: false },
        { new: true },
      );
      return { message: 'User deleted successfully' };
    } catch (error) {
      throw new UnauthorizedException(error?.message);
    }
  }
  async testDecrypt(body: any) {
    return processObject(body, 'decrypt');
  }
  async getUsers(req: any): Promise<any> {
    try {
      let {
        pageno = 1,
        limit = 10,
        search,
        user_type = UserType.User,
        filter = {},
        status,
      } = req.query || {};

      const stats = [
        ...countStat('_id', 'user', 'appointments', [
          // {
          //   $ne: ['$status', 'cancelled'],
          // },
        ]),
        ...countStat('_id', 'user', 'records'),
        ...countAlerts(),
      ];
      let obj: any = {
        ...filter,
        user_type: user_type,
      };
      const dr = req?.user?.user_type == UserType.Doctor;
      if (dr) {
        const userIds = await this.appointmentModel.distinct('user', {
          doctor: new mongoose.Types.ObjectId(req.user._id),
          status: { $ne: 'cancelled' },
        });
        if (userIds.length > 0) {
          obj._id = { $in: userIds };
        } else {
          obj._id = null; // No patients, so no users
        }
      }
      if (status) {
        obj.status = status;
      }
      const pipeline: any[] = [
        { $match: obj },
        { $sort: { createdAt: -1 } },
        ...stats,
      ]; // Match the filter
      if (search) {
        if (user_type === UserType.User) {
          search = processValue(search || '', 'hash');
          pipeline.push({
            $match: {
              $or: [
                { 'hashes.name': { $regex: search, $options: 'i' } },
                { 'hashes.email': { $regex: search, $options: 'i' } },
                { 'hashes.phone': { $regex: search, $options: 'i' } },
              ],
            },
          });
        } else {
          pipeline.push({
            $match: {
              $or: [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
              ],
            },
          });
        }
      }

      pipeline.push({
        $project: {
          name: 1,
          email: 1,
          phone: 1,
          country: 1,
          status: 1,
          hashes: 1,
          appointments: 1,
          records: 1,
          alerts: 1,
          userAlerts: 1,
          image: { $concat: [process.env.IB_URL || '', '$image'] },
        },
      });
      if (pageno && limit) {
        pipeline.push(paginationPipeline({ pageno, limit }));
      }
      const data = await this.userModel.aggregate(pipeline);

      const result = finalRes({ pageno, limit, data });
      const [count] = await this.userModel.aggregate(
        statusCounts(['active', 'inactive', 'blocked', 'deleted'], {
          user_type,
          ...(dr ? { _id: obj._id } : {}),
        }),
      );
      const fres = {
        meta: { ...result.meta, ...count },
        data: result?.data?.map((r: any) => {
          delete r?.hashes;
          return {
            ...processObject(r, 'decrypt'),
          };
        }),
      };
      return fres;
    } catch (err) {
      throw new Error(err?.message);
    }
  }
}
