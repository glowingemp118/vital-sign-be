import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { Record } from '../schemas/records.schema';
import { validateParams } from '../../utils/validations';
import { finalRes, paginationPipeline, sort } from '../../utils/dbUtils';
import { processValue } from '../../utils/encrptdecrpt';
import { Vital } from '../schemas/vital.schema';
import * as moment from 'moment-timezone';
import { time } from 'console';
@Injectable()
export class RecordService {
  constructor(
    @InjectModel('Record') private recordModel: Model<Record>,
    @InjectModel('Vital') private vitalModel: Model<Vital>,
  ) {}
  homeVitals = [
    'bloodPressure',
    'heartRate',
    'oxygenSaturation',
    'bloodGlucose',
  ];
  activityVitals = ['steps', 'restingEnergy', 'activeEnergy', 'flightClimbed'];
  async createUpdate(req: any): Promise<Record> {
    const body = req.body;
    const uid = new mongoose.Types.ObjectId(req?.user?._id);

    validateParams(this.recordModel.schema, body, {
      requiredFields: ['recorded_at', 'vital', 'value'],
      allowExtraFields: true,
    });

    let { recorded_at, vital, value, status } = body;

    // Ensure correct types
    const user = uid;
    // Use moment-timezone for date parsing
    const timezone = req?.user?.timzone || 'UTC';
    recorded_at = moment.tz(recorded_at, timezone).toDate();
    vital = new mongoose.Types.ObjectId(vital);
    value = processValue(String(value), 'encrypt');
    status = status || 'normal';

    // Check for existing record
    const existing = await this.recordModel
      .findOne({
        recorded_at,
        vital,
        user,
      })
      .exec();

    if (existing) {
      // Update existing record
      existing.value = value;
      existing.status = status;
      return existing.save();
    }

    // Create new record
    const newRecord = new this.recordModel({
      user,
      recorded_at,
      vital,
      value,
      status,
    });

    return newRecord.save();
  }
  async bulkCreateUpdate(req: any): Promise<Record[]> {
    const bodyArray = Array.isArray(req.body) ? req.body : [req.body];
    const user = req.user;
    const results: Record[] = [];

    const promises = bodyArray.map((body: any) =>
      this.createUpdate({ body, user }),
    );
    const settledResults = await Promise.allSettled(promises);
    for (const res of settledResults) {
      if (res.status === 'fulfilled') {
        results.push(res.value);
      }
    }

    return results;
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
    const uid = query?.uid || req?.user?._id;
    const isHome = home === 'true';
    const isActivity = activity === 'true';
    const timeFilter = time || '24hrs';

    // Define vital keys for home
    let vitals: string[] = [];
    if (isHome) {
      vitals = this.homeVitals;
    } else if (isActivity) {
      vitals = this.activityVitals;
    } else if (query.vital) {
      vitals = Array.isArray(query.vitals) ? query.vital : [query.vital];
    }
    const dvitals = await this.vitalModel
      .find({ key: { $in: vitals } })
      .lean()
      .exec();

    // Time range calculation
    let timezone = user?.timezone || 'UTC'; // Fixed typo from 'timzone' to 'timezone'
    if (!moment.tz.names().includes(timezone)) {
      console.error(`Invalid timezone: ${timezone}. Defaulting to UTC.`);
      timezone = 'UTC';
    }
    let now = moment.tz(timezone);
    let startDate = now.clone();

    if (from && to) {
      startDate = moment.tz(from, timezone);
      now = moment.tz(to, timezone);
    } else if (timeFilter === '24hrs') {
      startDate = now.clone().subtract(1, 'day');
    } else if (timeFilter === '7days') {
      startDate = now.clone().subtract(7, 'days');
    } else if (timeFilter === '30days') {
      startDate = now.clone().subtract(30, 'days');
    } else {
      startDate = moment.tz(0, timezone); // all time
    }

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
          recorded_at: new Date(),
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

  private formatGraphData(records: any[]): any[] {
    // Group records by recorded_at date (YYYY-MM-DD)
    const grouped: { [date: string]: any[] } = {};

    records.forEach((rec: any) => {
      const date = moment(rec.recorded_at).format('YYYY-MM-DD');
      if (!grouped[date]) grouped[date] = [];
      let formatted: any = { value: rec.value, recorded_at: rec.recorded_at };
      if (rec.vital?.key === 'bloodPressure' && typeof rec.value === 'string') {
        const [diastolic, systolic] = rec.value.split('/').map(Number) || [
          '0',
          '0',
        ];
        formatted = { ...formatted, diastolic, systolic };
      }
      grouped[date].push(formatted);
    });

    // Convert grouped object to array sorted by date
    return Object.entries(grouped)
      .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
      .map(([date, records]) => ({
        date,
        records,
      }));
  }

  async homeRecords(req: any) {
    const user = req.user;
    const { time } = req.query || {};
    // Get latest home vitals, sorted by homeVitals order
    const homeResRaw = await this.vitalRecords({
      query: { home: 'true' },
      user,
    });

    const homeRes = this.homeVitals
      .map((key) => homeResRaw.find((rec: any) => rec.vital?.key === key))
      .filter(Boolean);

    // Get latest activity vital (steps)
    const activityResRaw = await this.vitalRecords({
      query: { vital: 'steps' },
      user,
    });

    const activityRes = activityResRaw[0] || null;

    // Get blood pressure graph data for 7 days
    const bpRes = await this.vitalRecords({
      query: { vital: 'bloodPressure', time: time || '7days' },
      user,
    });
    const bpGraph = this.formatGraphData(bpRes);

    return {
      records: homeRes,
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

  async findOne(id: string): Promise<Record> {
    return;
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
}
