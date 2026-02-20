import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { Record } from '../schemas/records.schema';
import { validateParams } from '../../utils/validations';
import {
  finalRes,
  paginationPipeline,
  recordsPipeline,
  sort,
  statusCounts,
} from '../../utils/dbUtils';
import { processObject, processValue } from '../../utils/encrptdecrpt';
import { Vital } from '../schemas/vital.schema';
import { getVitalMessage, getVitalStatus } from 'src/utils/appUtils';
import { User } from 'src/user/schemas/user.schema';
import moment from 'moment-timezone';
import { Appointment } from '../schemas/appointments.schema';
import { UserType } from 'src/user/dto/user.dto';
import { Alert } from '../schemas/alert.schema';
@Injectable()
export class RecordService {
  constructor(
    @InjectModel(Record.name) private recordModel: Model<Record>,
    @InjectModel(Vital.name) private vitalModel: Model<Vital>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Appointment.name) private appointmentModel: Model<Appointment>,
    @InjectModel(Alert.name) private alertModel: Model<Alert>,
  ) {}
  homeVitals = [
    'bloodPressure',
    'heartRate',
    'oxygenSaturation',
    'bloodGlucose',
  ];
  activityVitals = ['steps', 'walkingRunningDistance'];
  async createUpdate(req: any): Promise<Record> {
    try {
      const body = req.body;
      const uid = new mongoose.Types.ObjectId(req?.user?._id);

      validateParams(this.recordModel.schema, body, {
        requiredFields: ['recorded_at', 'vital', 'value'],
        allowExtraFields: true,
      });

      let { recorded_at, vital, value } = body;

      // Ensure correct types
      const user = uid;
      // Use moment-timezone for date parsing
      const timezone = req?.user?.timezone || 'UTC';
      recorded_at = moment.tz(recorded_at, timezone).toDate();
      console.log(`Recorded at: ${recorded_at} in timezone: ${timezone}`);

      vital = new mongoose.Types.ObjectId(vital);

      const vitalDoc = await this.vitalModel.findById(vital).exec();
      if (!vitalDoc) {
        throw new Error('Vital not found');
      }
      // Check for existing record
      const existing = await this.recordModel
        .findOne({
          recorded_at,
          vital,
          user,
        })
        .exec();
      if (existing) {
        return existing;
      }
      const vstatus = getVitalStatus(vitalDoc.key as any, value);
      // Create new record
      const newRecord = new this.recordModel({
        user,
        recorded_at,
        vital,
        value: processValue(String(value), 'encrypt'),
        status: vstatus !== 'unknown' ? vstatus : 'normal',
      });
      await newRecord.save();
      if (body.isSaved) {
        await this.addAlert(user, vitalDoc, { value, recorded_at }, vstatus);
      }
      return newRecord;
    } catch (error) {
      throw new Error(error?.message);
    }
  }

  async addAlert(
    userId: mongoose.Types.ObjectId,
    vitalDoc: Vital,
    body: any,
    vstatus: string,
  ) {
    try {
      if (vstatus == 'normal' || vstatus == 'unknown') {
        this.alertModel
          .updateOne(
            { user: userId },
            { $pull: { alerts: { vital: vitalDoc.key } } },
          )
          .exec();
        return;
      }
      const msg = getVitalMessage(vitalDoc, body.value, vstatus);
      if (!msg) return;

      const alert = {
        vital: vitalDoc.key,
        status: vstatus,
        label: msg.label,
        message: msg.message,
        recorded_at: body.recorded_at,
      };
      const result = await this.alertModel.updateOne(
        { user: userId, 'alerts.vital': vitalDoc.key },
        {
          $set: {
            'alerts.$': alert,
          },
        },
      );
      if (result.matchedCount === 0) {
        await this.alertModel.updateOne(
          { user: userId },
          { $push: { alerts: alert } },
          { upsert: true },
        );
      }
    } catch (error) {
      throw new Error(error?.message);
    }
  }

  async bulkCreateUpdate(req: any): Promise<any> {
    const bodyArray = Array.isArray(req.body) ? req.body : [req.body];
    const user = req.user;
    const results: Record[] = [];
    const savedVitalIds = new Set<string>();

    const promises = [...bodyArray]
      .sort(
        (a, b) =>
          new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
      )
      .map((body) => {
        const isSaved = !savedVitalIds.has(body.vital);
        if (isSaved) savedVitalIds.add(body.vital);

        return this.createUpdate({
          body: { ...body, isSaved },
          user,
        });
      });
    const settledResults = await Promise.allSettled(promises);
    for (const res of settledResults) {
      if (res.status === 'fulfilled') {
        results.push(res.value);
      }
    }
    const homeRes = await this.homeRecords({ user });
    return homeRes;
  }
  getDateFilter(
    from: string,
    to: string,
    timeFilter: string,
    timezone: string = 'UTC',
  ) {
    // console.log(timezone, 'timezone');

    let now = moment().tz(timezone); // Set 'now' to the current time in the user timezone
    let startDate = moment().tz(timezone); // Default start date in user timezone
    if (from && to) {
      const fromDate = moment(from)
        .tz(timezone, true)
        .set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
      startDate = fromDate;

      const toDate = moment(to)
        .tz(timezone, true)
        .set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
      now = toDate;
    } else if (timeFilter === '24hrs') {
      startDate = moment().tz(timezone); // 24hrs filter uses the current time
    } else if (timeFilter === '7days') {
      startDate = moment().tz(timezone).subtract(7, 'days');
    } else if (timeFilter === '30days') {
      startDate = moment().tz(timezone).subtract(30, 'days');
    } else {
      startDate = moment(0).tz(timezone); // all time, set to epoch time
    }

    return { startDate: startDate.toDate(), now: now.toDate() }; // Convert to Date objects before returning
  }
  async vitalRecords(req: any): Promise<any> {
    const { query, user } = req;
    const {
      home,
      activity,
      time,
      from,
      to,
      filter,
      sort = 'desc',
    } = query || {};
    const uid = query?.uid || user?._id;
    const isHome = home === 'true';
    const isActivity = activity === 'true';
    const timeFilter = time || '7days';
    // Define vital keys for home
    let vitals: string[] = [];
    if (isHome) {
      vitals = this.homeVitals;
    } else if (isActivity) {
      vitals = this.activityVitals;
    } else if (query.vital) {
      vitals = Array.isArray(query.vitals) ? query.vitals : [query.vital];
    }
    const dvitals = await this.vitalModel
      .find({ key: { $in: vitals } })
      .lean()
      .exec();

    // Time range calculation
    // let timezone = user?.timezone || 'UTC'; // Fixed typo from 'timzone' to 'timezone'

    const { startDate, now } = this.getDateFilter(
      from,
      to,
      timeFilter,
      user?.timezone,
    );

    // Build query
    const match: any = {
      ...filter,
      user: new mongoose.Types.ObjectId(uid),
      recorded_at: { $gte: startDate, $lte: now },
    };
    if (vitals.length) {
      match.vital = { $in: dvitals.map((v) => v._id) };
    }
    const records = await this.recordModel
      .find(match)
      .populate('vital')
      .sort({ recorded_at: sort === 'asc' ? 1 : -1 })
      .lean()
      .exec();

    // Decrypt values
    const result = records.map((rec: any) => {
      return {
        ...rec,
        value: rec.value ? processValue(rec.value, 'decrypt') : rec.value,
      };
    });
    dvitals.forEach((vital) => {
      if (!result.some((r) => r?.vital.key === vital?.key)) {
        result.push({
          recorded_at: from && to ? new Date(to) : new Date(),
          vital,
          value: '0',
          status: 'normal',
        });
      }
    });
    return result;
  }

  async singleVital(req: any): Promise<any> {
    const { key, id } = req.query || {};
    if (!key && !id) {
      throw new Error('key or id query is required');
    }
    const q = {};
    if (id) {
      q['_id'] = new mongoose.Types.ObjectId(id);
    }
    if (key) {
      q['key'] = { $regex: new RegExp(key.trim(), 'i') };
    }
    // Find the vital by key (case-insensitive)
    const vital = await this.vitalModel.findOne(q).exec();
    return vital;
  }

  private formatGraphData(records: any[], checkToday: boolean = true): any[] {
    // Group records by recorded_at date (YYYY-MM-DD)
    const grouped: { [date: string]: any[] } = {};

    records.forEach((rec: any) => {
      const date = new Date(rec.recorded_at).toISOString().split('T')[0];
      if (!grouped[date]) grouped[date] = [];
      let formatted: any = {
        value: rec.value,
        recorded_at: rec.recorded_at,
        // vital: rec.vital?.key,
      };
      if (rec.vital?.key === 'bloodPressure' && typeof rec.value === 'string') {
        const [systolic = 0, diastolic = 0] = rec.value
          .split('/')
          .map(Number) || ['0', '0'];
        formatted = { ...formatted, diastolic, systolic };
      }
      grouped[date].push(formatted);
    });

    // Convert grouped object to array sorted by date
    return Object.entries(grouped)
      .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
      .map(([date, records]) => {
        if (checkToday) {
          const today = new Date().toISOString().split('T')[0]; // Get today's date in YYYY-MM-DD format
          if (date !== today) {
            records = [records[0]]; // Keep only the latest record
          }
        }
        return {
          date,
          records,
        };
      });
  }

  async homeRecords(req: any): Promise<any> {
    const user = req.user;

    let { time, from, to } = req.query || {};

    const homeResRaw = await this.vitalRecords({
      query: { home: 'true', time },
      user,
    });

    const homeRes = this.homeVitals
      .map((key) => homeResRaw.find((rec: any) => rec.vital?.key === key))
      .filter(Boolean);

    // Get latest activity vital (steps)
    const activityResRaw = await this.vitalRecords({
      query: { vital: 'steps', time },
      user,
    });

    const activityRes = activityResRaw[0] || null;

    // Get blood pressure graph data for 7 days
    const bpRes = await this.vitalRecords({
      query: { vital: 'bloodPressure', time: time || '7days' },
      user,
    });
    const bpGraph = this.formatGraphData(bpRes);
    let userData: any = null;
    if (req.fetchUser) {
      const duser = await this.userModel
        .findById(new mongoose.Types.ObjectId(user._id))
        .select('email name image country phone')
        .lean();
      if (duser) {
        duser.image = duser.image
          ? `${process.env.IB_URL}${duser.image}`
          : 'noimage.png';

        userData = processObject(duser, 'decrypt');
      }
    }
    const { startDate, now } = this.getDateFilter(
      from,
      to,
      time || '7days',
      user?.timezone,
    );
    const alert = await this.alertModel
      .findOne({
        user: new mongoose.Types.ObjectId(user._id),
        'alerts.recorded_at': { $gte: startDate, $lte: now },
      })
      .lean()
      .exec();
    return {
      ...(userData && { user: userData }),
      records: homeRes,
      alerts: alert?.alerts || [],
      activity: activityRes,
      trendGraph: bpGraph || [],
    };
  }

  async singleVitalRecord(req: any) {
    const user = req.user;

    const { vital, time = '7days' } = req.query || {};
    if (!vital) {
      throw new Error('vital query  is required');
    }

    const vitalDoc = await this.vitalModel
      .findOne({ key: vital })
      .lean()
      .exec();
    if (!vitalDoc) {
      throw new Error('Vital not found');
    }
    // Get latest home vitals, sorted by homeVitals order
    const vRes = await this.vitalRecords({
      query: { vital: vital, time: time },
      user,
    });
    const tGraph = this.formatGraphData(vRes);
    return {
      record: vRes[0] || { vital: vitalDoc },
      trendGraph: tGraph || [],
    };
  }

  async activityRecords(req: any) {
    const user = req.user;

    const getRecords = async (time: string) =>
      this.vitalRecords({
        query: { activity: 'true', time, sort: 'asc' },
        user,
      });

    const [res24hrs, res7days, res1month] = await Promise.all([
      getRecords('24hrs'),
      getRecords('7days'),
      getRecords('30days'),
    ]);

    const getUniqueRecords = (res: any[]) =>
      this.activityVitals
        .map((key) => res.find((rec: any) => rec.vital?.key === key))
        .filter(Boolean);

    const restActivities = await this.vitalModel
      .find({ key: { $nin: [...this.homeVitals, ...this.activityVitals] } })
      .exec();

    return {
      records: {
        last24hrs: getUniqueRecords(res24hrs),
        last7days: getUniqueRecords(res7days),
        last1month: getUniqueRecords(res1month),
      },
      restActivities,
    };
  }

  async getVitals(req: any): Promise<any> {
    const { pageno, limit, search, filter } = req.query || {};
    let obj: any = { ...filter };
    try {
      const pipeline: any[] = [{ $match: obj }]; // Match the filter
      if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination
      const data = await this.vitalModel.aggregate(pipeline); // Using the ContactSupport model to aggregate
      const result = finalRes({ pageno, limit, data });
      return result;
    } catch (err) {
      throw new Error(err?.message);
    }
  }

  async update(id: string, updateRecordDto: any): Promise<Record> {
    return this.recordModel
      .findByIdAndUpdate(id, { $set: updateRecordDto }, { new: true })
      .exec();
  }

  async remove(id: string): Promise<Record> {
    const record = await this.recordModel.findById(id).exec();
    await this.recordModel.deleteOne({ _id: id });
    return record;
  }

  async getRecords(req: any): Promise<any> {
    try {
      const { pageno, limit, search, filter = {}, status } = req.query || {};
      let obj: any = {
        ...filter,
      };
      const isDoctor = req?.user?.user_type === UserType.Doctor;

      if (isDoctor) {
        const userIds = await this.appointmentModel.distinct('user', {
          doctor: new mongoose.Types.ObjectId(req?.user?._id),
          status: { $ne: 'cancelled' },
        });
        if (userIds.length > 0) {
          obj.user = { $in: userIds };
        } else {
          obj.user = null; // No patients, so no records
        }
      }
      if (status) {
        obj.status = status;
      }
      const pipeline: any[] = [{ $match: obj }, ...recordsPipeline(search)];
      if (pageno && limit) {
        pipeline.push(paginationPipeline({ pageno, limit }));
      }
      const data = await this.recordModel.aggregate(pipeline);
      const result = finalRes({ pageno, limit, data });
      const [count] = await this.recordModel.aggregate(
        statusCounts(
          ['normal', 'high', 'low', 'critical'],
          isDoctor ? { user: obj.user } : {},
        ),
      );
      const fres = {
        meta: { ...result.meta, ...count },
        data: result?.data?.map((r: any) => {
          delete r?.user?.hashes;
          return {
            ...r,
            user: processObject(r.user, 'decrypt'),
            value: processValue(r.value, 'decrypt'),
          };
        }),
      };
      return fres;
    } catch (err) {
      throw new Error(err?.message);
    }
  }
  async historyRecords(req: any): Promise<any> {
    try {
      const user = req.user;
      let { from, to, date, vital } = req.query || {};
      const filter = { from, to };
      // Get latest home vitals, sorted by homeVitals order
      if (date) {
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);
        filter.from = start.toISOString();
        filter.to = end.toISOString();
      }
      if (vital) {
        filter['vital'] = vital;
      } else {
        filter['home'] = 'true';
      }
      const homeResRaw = await this.vitalRecords({
        query: { ...filter },
        user,
      });
      if (date || vital) {
        const homeRes = this.homeVitals
          .map((key) => homeResRaw.find((rec: any) => rec.vital?.key === key))
          .filter(Boolean);

        return {
          record: homeRes[0] || null,
          trendGraph: this.formatGraphData(homeResRaw, false),
        };
      }
      const startDate = new Date(from);
      const endDate = new Date(to);

      // Create an array of all dates between the from and to date
      const allDates = [];
      for (
        let current = startDate;
        current <= endDate;
        current.setDate(current.getDate() + 1)
      ) {
        allDates.push(new Date(current).toISOString().split('T')[0]); // Store only the YYYY-MM-DD part
      }

      // Map each date to its corresponding vital records
      const result = allDates.map((dateKey) => {
        // Filter records for the current date
        const recordsForDate = homeResRaw.filter((record: any) => {
          const recordDate = new Date(record?.recorded_at)
            .toISOString()
            .split('T')[0]; // Extract the date part
          return recordDate === dateKey;
        });
        // Map to homeVitals keys, ensuring there are 4 records (if available)
        const homeRes = this.homeVitals?.map((key) => {
          let rec = recordsForDate.find((rec: any) => rec.vital?.key === key);
          if (!rec) {
            const prec = homeResRaw.find((rec: any) => rec.vital?.key === key);
            rec = {
              ...prec,
              value: '0',
              recorded_at: new Date(dateKey),
              status: 'normal',
            };
          }
          return rec;
        });
        return {
          date: dateKey,
          records: homeRes,
        };
      });

      return result;
    } catch (error) {
      throw new Error(error?.message);
    }
  }
}
