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
  SocialAuthDto,
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
import { ContactType } from 'src/contact-type/schemas/contac-type.schema';
import { sendEmail } from 'src/utils/email/emailUtils';
import { Notification } from 'src/notification/notification.schema';
import { Record } from 'src/features/schemas/records.schema';
import { Alert } from 'src/features/schemas/alert.schema';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Device.name) private deviceModel: Model<DevicesDocument>,
    @InjectModel(Doctor.name) private doctorModel: Model<any>,
    @InjectModel(Speciality.name) private specialityModel: Model<any>,
    @InjectModel(Appointment.name) private appointmentModel: Model<any>,
    @InjectModel(ContactType.name) private contactTypeModel: Model<ContactType>,
    @InjectModel(Notification.name)
    private notificationModel: Model<Notification>,
    @InjectModel(Record.name) private recordModel: Model<Record>,
    @InjectModel(Alert.name) private alertModel: Model<Alert>,
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
      let {
        name,
        email,
        phone,
        password,
        user_type,
        timezone,
        medicalConditions,
      } = dto;
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

      if (phone?.trim()) {
        const existingByPhone = await this.findUserByPhone(phone);
        if (
          existingByPhone &&
          existingByPhone.status !== 'deleted' &&
          (!isExistingUser ||
            String(existingByPhone._id) !== String(isExistingUser._id))
        ) {
          throw new UnauthorizedException('Phone number already exists');
        }
      }

      password = await bcrypt.hash(password, 10);
      const isUser = user_type === UserType.User;
      const encryted_obj = processObject({ name, email, phone }, 'encrypt');
      const hash_obj = processObject({ name, email, phone }, 'hash');

      const userData: any = {
        ...dto,
        rc_uid: dto?.rc_uid ? [dto.rc_uid] : [],
        email,
        password: password,
        otp: this.generateOtp(),
        roles: [user_type],
        image: dto?.image || 'noimage.png',
        timezone: timezone || 'UTC',
        medicalConditions,
        // Always store phone hash so doctor/patient uniqueness can be checked across roles
        hashes: { ...(isExistingUser?.hashes || {}), ...hash_obj },
        ...(isUser ? { ...encryted_obj } : {}),
      };
      const user = isExistingUser
        ? Object.assign(isExistingUser, userData)
        : new this.userModel(userData);

      let savedUser: any = await user.save();
      await sendEmail({
        to: user.email,
        subject: 'Email Verification OTP',
        type: 'otp',
        data: {
          user: { name: name, email: email },
          otp: user.otp,
          expiresInMinutes: 15,
        },
      });
      if (dto?.device_id && dto?.device_type) {
        await this.upsertDeviceTokens(savedUser._id, {
          device_id: dto.device_id,
          device_type: dto.device_type,
          voip_token: dto.voip_token,
        });
      } else if (dto?.voip_token) {
        await this.upsertDeviceTokens(savedUser._id, {
          device_type: dto.device_type || 'ios',
          voip_token: dto.voip_token,
        });
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

  // Find a user by phone (plain doctor phone or hashed patient phone)
  async findUserByPhone(phone: string): Promise<UserDocument | null> {
    const normalized = String(phone || '').trim();
    if (!normalized) return null;
    const hash_phone = processValue(normalized, 'hash');
    const user = await this.userModel.findOne({
      $or: [{ 'hashes.phone': hash_phone }, { phone: normalized }],
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

       const device_types=['ios','android'];

      if( signInDto?.device_type && device_types.includes(signInDto?.device_type)){
         if(user.user_type===2){
            throw new BadRequestException("Only patient can login with android or ios device");
         }
      }
      if(signInDto?.device_type && signInDto.device_type==="web" ){
        if(user.user_type!==2 && user.user_type!==3){
          throw new BadRequestException("Only admin or doctor can login with web device");
        }
      }

      if (user.status !== 'active') {
        throw new UnauthorizedException(`Account is ${user.status}`);
      }

      if (!user.is_verified) {
        throw new UnauthorizedException('Email is not verified');
      }
      if (signInDto?.device_id || signInDto?.voip_token) {
        await this.upsertDeviceTokens(user._id, {
          device_id: signInDto.device_id,
          device_type: signInDto.device_type,
          voip_token: signInDto.voip_token,
        });
      }
      if (signInDto?.rc_uid) {
        user = await this.userModel.findByIdAndUpdate(
          user._id,
          {
            $addToSet: {
              rc_uid: signInDto.rc_uid,
            },
          },
          { new: true },
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
      throw new BadRequestException(error?.message);
    }
  }

  async socialAuth(socialAuthDto: SocialAuthDto) {
    // const session = await this.userModel.db.startSession();
    // session.startTransaction();

    try {
      const {
        provider,
        socialId,
        email,
        name,
        device_id,
        device_type,
        voip_token,
        timezone,
        rc_uid,
      } = socialAuthDto;

      let user: any = await this.userModel.findOne({ email });
      const password = await bcrypt.hash('123456', 10);
      if (user) {
        if (user.status !== 'active') {
          throw new UnauthorizedException(`Account is ${user.status}`);
        }

        const providerIdField = `${provider}Id`;

        if (!user[providerIdField]) {
          user[providerIdField] = socialId;
        }

        user.provider = provider;

        if (timezone) {
          user.timezone = timezone;
        }

        if (rc_uid && !user.rc_uid.includes(rc_uid)) {
          user.rc_uid.push(rc_uid);
        }
        user.is_verified = true;

        await user.save();
      } else {
        const providerIdField = `${provider}Id`;
        user = new this.userModel({
          name,
          email,
          provider,
          [providerIdField]: socialId,
          timezone: timezone || 'UTC',
          is_verified: true,
          status: 'active',
          password,
        });

        await user.save();
      }

      if (device_id || voip_token) {
        await this.upsertDeviceTokens(user._id, {
          device_id,
          device_type,
          voip_token,
        });
      }

      const token_res = generateToken(user);

      if (user?.user_type === UserType.Doctor) {
        user = user.toObject();

        const doctor = await this.doctorModel
          .findOne({ user: user._id })
          .populate('specialties');

        user.doctor = doctor;
      }

      // await session.commitTransaction();
      // session.endSession();

      return {
        user: modifiedUser(user),
        token_res,
      };
    } catch (error) {
      // await session.abortTransaction();
      // session.endSession();

      throw new UnauthorizedException(error?.message || 'Social auth failed');
    }
  }

  // Update a user's profile
  async updateProfile(id: string, updateUserDto: UpdateUserDto): Promise<any> {
    const { rc_uid, ...restUpdateUserDto } = updateUserDto;

    if (restUpdateUserDto?.phone?.trim()) {
      const existingByPhone = await this.findUserByPhone(restUpdateUserDto.phone);
      if (
        existingByPhone &&
        existingByPhone.status !== 'deleted' &&
        String(existingByPhone._id) !== String(id)
      ) {
        throw new UnauthorizedException('Phone number already exists');
      }
      const hash_phone = processValue(restUpdateUserDto.phone.trim(), 'hash');
      (restUpdateUserDto as any).hashes = {
        ...((await this.userModel.findById(id).select('hashes').lean())?.hashes ||
          {}),
        phone: hash_phone,
      };
    }

    const updateQuery: any = {
      $set: restUpdateUserDto,
    };

    if (rc_uid) {
      updateQuery.$addToSet = {
        rc_uid,
      };
    }

    const updatedUser = await this.userModel.findByIdAndUpdate(
      id,
      updateQuery,
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
    await sendEmail({
      to: user.email,
      subject: 'Email Verification OTP',
      type: 'otp',
      data: {
        user: {
          name: processValue(user.name, 'decrypt'),
          email: processValue(user.email, 'decrypt'),
        },
        otp: otp,
        expiresInMinutes: 15,
      },
    });
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
    return this.upsertDeviceTokens(user, { device_id, device_type });
  }

  /**
   * Upsert FCM + optional iOS PushKit VoIP token for a user.
   * Mobile calls PUT /auth/device-tokens and also sends voip_token on login.
   */
  async upsertDeviceTokens(
    userId: string,
    body: { device_id?: string; device_type?: string; voip_token?: string },
  ) {
    try {
      const device_id = body.device_id?.trim() || undefined;
      const voip_token = body.voip_token?.trim() || undefined;
      const device_type = (body.device_type || (voip_token ? 'ios' : '')).toLowerCase();

      if (!userId) {
        throw new UnauthorizedException('Invalid parameters for devices');
      }
      if (!device_id && !voip_token) {
        return { message: 'No device tokens provided' };
      }
      if (device_id && device_id.length < 50 && device_type !== 'web') {
        return { message: 'Device ID is too short to be valid' };
      }

      const userOid = new mongoose.Types.ObjectId(userId);
      let devicesDoc: any = await this.deviceModel.findOne({ user: userOid });
      // Legacy docs stored user as plain string — find and normalize
      if (!devicesDoc) {
        devicesDoc = await this.deviceModel.findOne({ user: userId });
        if (devicesDoc) {
          devicesDoc.user = userOid;
        }
      }
      if (!devicesDoc) {
        devicesDoc = new this.deviceModel({
          user: userOid,
          devices: [],
        });
      }

      let idx = -1;
      if (device_id) {
        idx = devicesDoc.devices.findIndex((d: any) => d.device_id === device_id);
      }
      if (idx === -1 && voip_token) {
        idx = devicesDoc.devices.findIndex((d: any) => d.voip_token === voip_token);
      }
      // Prefer updating the newest iOS row so voip-only calls don't create orphans
      if (idx === -1 && (device_type === 'ios' || voip_token)) {
        for (let i = devicesDoc.devices.length - 1; i >= 0; i--) {
          if (String(devicesDoc.devices[i].device_type || '').toLowerCase() === 'ios') {
            idx = i;
            break;
          }
        }
      }

      if (idx !== -1) {
        if (device_type) devicesDoc.devices[idx].device_type = device_type;
        if (device_id) devicesDoc.devices[idx].device_id = device_id;
        if (voip_token) devicesDoc.devices[idx].voip_token = voip_token;
      } else {
        devicesDoc.devices.push({
          device_id: device_id || undefined,
          device_type: device_type || 'ios',
          voip_token: voip_token || undefined,
        });
      }

      // Keep multiple Android devices so incoming calls can ring all logged-in phones.
      // Stale FCM tokens are pruned when sendIncomingCallPush gets not-registered errors.

      await devicesDoc.save();
      const voipLen = voip_token?.length || 0;
      console.log(
        `[Device] upsert user=${userId} type=${device_type || 'n/a'} hasFcm=${!!device_id} fcmLen=${device_id?.length || 0} hasVoip=${!!voip_token} voipLen=${voipLen}`,
      );
      if (voip_token && voipLen > 100) {
        console.warn(
          `[Device] voip_token length=${voipLen} looks like an FCM token — PushKit tokens are usually ~64 hex chars. DeviceTokenNotForTopic will occur if wrong token type.`,
        );
      }
      return {
        message: 'Device tokens updated',
        devices: devicesDoc.devices,
      };
    } catch (error: any) {
      throw new UnauthorizedException(error?.message);
    }
  }

  // // Logout: remove deviceId from user's devices
  async logout(userId: string, deviceId: string) {
    try {
      if (!deviceId) {
        throw new Error('Device ID is required for logout');
      }
      const devicesDoc: any = await this.deviceModel.findOne({
        user: new mongoose.Types.ObjectId(userId),
      });
      if (devicesDoc) {
        devicesDoc.devices = devicesDoc.devices.filter(
          (device: any) => device.device_id !== deviceId,
        );
        await devicesDoc.save();
      }

      return { message: 'Logged out successfully' };
    } catch (error) {
      console.log(error.message);

      throw new BadRequestException(error?.message);
    }
  }
  // Soft delete a user by updating status to 'deleted'
  async softDeleteUser(userId: string) {
    try {
      let user: any = await this.userModel.findById(userId).lean();
      user = processObject(user, 'decrypt');
      const userEmail = processValue(user.email, 'decrypt');
      const newEmail = `${userEmail.split('@')[0]}-deleted-${Date.now()}@${userEmail.split('@')[1]}`;

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
        {
          status: 'deleted',
          is_verified: false,
          previousEmail: user.email,
          name: user.name + ' (deleted)',
          email: newEmail,
          rc_uid: [],
          hashes: { name: '', email: '', phone: '' },
          ...(user.provider !== 'local'
            ? { provider: 'local', [`${user.provider}Id`]: '' }
            : {}),
        },
        { new: true },
      );
      await Promise.all([
        this.deviceModel.deleteOne({ user: user._id }).exec(), // Remove associated devices
        this.appointmentModel.updateMany(
          { user: user._id, status: { $ne: 'completed' } },
          { status: 'cancelled' },
        ),
        this.notificationModel.updateMany(
          { user: user._id },
          { status: 'deleted' },
        ),
        this.recordModel.deleteMany({ user: user._id }),
        this.alertModel.deleteMany({ user: user._id }),
      ]);
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
      const dr = req?.user?.user_type == UserType.Doctor;
      let obj: any = {
        ...filter,
        user_type: user_type,
      };
      if (dr) {
        const userIds = await this.appointmentModel.distinct('user', {
          doctor: new mongoose.Types.ObjectId(req.user._id),
          // status: { $ne: 'cancelled' },
        });
        if (userIds.length > 0) {
          obj._id = { $in: userIds };
        } else {
          obj._id = null; // No patients, so no users
        }
      }
      const stats = [
        ...countStat(
          '_id',
          'user',
          'appointments',
          dr
            ? [{ $eq: ['$doctor', new mongoose.Types.ObjectId(req.user._id)] }]
            : [],
        ),
        ...countStat('_id', 'user', 'records'),
        ...countAlerts(),
      ];

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
          gender: 1,
          hashes: 1,
          appointments: 1,
          records: 1,
          alerts: 1,
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

        data: await Promise.all(
          result?.data?.map(async (r: any) => {
            let contactType = await this.contactTypeModel.aggregate([
              {
                $match: {
                  $expr: {
                    $eq: ['$user', new mongoose.Types.ObjectId(r?._id)],
                  },
                },
              },
              {
                $project: {
                  type: 1,
                  contact: 1,
                },
              },
            ]);

            delete r?.hashes;

            return {
              ...processObject(r, 'decrypt'),
              contactType,
            };
          }),
        ),
      };

      return fres;
    } catch (err) {
      throw new Error(err?.message);
    }
  }
  async rcWebhookEvent(event: any) {
    try {
      const activeEvents = ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION'];

      const {
        app_user_id: userId,
        product_id: productId,
        expiration_at_ms,
      } = event;

      const expiresAt = expiration_at_ms ? new Date(expiration_at_ms) : null;

      let subscription;

      if (activeEvents.includes(event.type)) {
        subscription = {
          isSubscribed: true,
          subscriptionStatus: 'active',
          productId,
          expiresAt,
        };
      } else if (event.type === 'CANCELLATION') {
        subscription = {
          isSubscribed: true,
          subscriptionStatus: 'cancelled',
          productId: null,
          expiresAt,
        };
      } else if (event.type === 'BILLING_ISSUE') {
        subscription = {
          isSubscribed: false,
          subscriptionStatus: 'billing_issue',
          productId: null,
          expiresAt: null,
        };
      } else if (event.type === 'EXPIRATION') {
        subscription = {
          isSubscribed: false,
          subscriptionStatus: 'inactive',
          productId: null,
          expiresAt: null,
        };
      } else {
        console.log('Unhandled RevenueCat event:', event.type);
        return { success: true, message: 'Unhandled event' };
      }

      await this.userModel.updateOne(
        { rc_uid: { $in: [userId] }, status: 'active' },
        { subscription },
      );

      return {
        success: true,
        message: 'RevenueCat webhook processed successfully',
      };
    } catch (error) {
      console.error('Error handling RevenueCat webhook:', error);
      throw error;
    }
  }
}
