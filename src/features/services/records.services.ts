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
import {
  buildAlertEntry,
  buildRecordOp,
  dedupeByVital,
  getLast24HoursBoundary,
  getVitalMessage,
  getVitalStatus,
} from 'src/utils/appUtils';
import { User } from 'src/user/schemas/user.schema';
import moment from 'moment-timezone';
import { Appointment } from '../schemas/appointments.schema';
import { UserType } from 'src/user/dto/user.dto';
import { Alert } from '../schemas/alert.schema';
import { Types } from 'mongoose';
import { NotificationService } from 'src/notification/notification.service';
import { HospitalUser } from '../schemas/HospitalUser.schema';
import { Specialist } from '../schemas/specialist.schema';
import { sendEmail } from 'src/utils/email/emailUtils';

@Injectable()
export class RecordService {
  constructor(
    @InjectModel(Record.name) private recordModel: Model<Record>,
    @InjectModel(Vital.name) private vitalModel: Model<Vital>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Appointment.name) private appointmentModel: Model<Appointment>,
    @InjectModel(Alert.name) private alertModel: Model<Alert>,
    @InjectModel(HospitalUser.name)
    private hospitalUserModel: Model<HospitalUser>,
    @InjectModel(Specialist.name) private specialistModel: Model<Specialist>,
    private readonly notificationService: NotificationService,
  ) {}
  homeVitals = [
    'bloodPressure',
    'heartRate',
    'oxygenSaturation',
    'bloodGlucose',
  ];
  activityVitals = [
    'steps',
    'restingEnergy',
    'activeEnergy',
    'walkingRunningDistance',
    'move',
    'flightClimbed',
  ];

  async createVitalNotification(
    userId: any,
    vitalDoc: any,
    value: any,
    vstatus: string,
  ): Promise<void> {
    try {
      const vitalName: string = vitalDoc.name ?? vitalDoc.key ?? 'Vital';

      const { title, message } =
        this.notificationService.buildNotificationContent(
          vstatus,
          vitalName,
          value,
        );
      const object = {
        // matches your Notification.object field
        vitalId: JSON.stringify(vitalDoc._id),
        vitalKey: vitalDoc.key,
        value,
        status: vstatus,
      };
      await this.notificationService.sendNotification({
        userId: userId,
        title,
        message,
        type: 'vital',
        object: object,
      });
    } catch (err) {
      // Never let a notification failure break the record-saving flow
      console.error(
        '[Notification] Failed to create vital notification:',
        err?.message,
      );
    }
  }

  async createUpdate(req: any): Promise<Record> {
    try {
      const body = req.body;
      const uid = new mongoose.Types.ObjectId(req?.user?._id);

      validateParams(this.recordModel.schema, body, {
        requiredFields: ['recorded_at', 'vital', 'value'],
        allowExtraFields: true,
      });

      let { recorded_at, vital, value } = body;

      const user = uid;
      const timezone = req?.user?.timezone || 'UTC';
      recorded_at = new Date(recorded_at);
      vital = new mongoose.Types.ObjectId(vital);

      const vitalDoc = await this.vitalModel.findById(vital).exec();
      if (!vitalDoc) {
        throw new Error('Vital not found');
      }

      const vstatus = getVitalStatus(vitalDoc.key as any, value);

      // Check for existing record
      const existing = await this.recordModel
        .findOne({
          recorded_at,
          vital: new mongoose.Types.ObjectId(vital),
          user: new mongoose.Types.ObjectId(uid),
        })
        .exec();

      let savedRecord: Record;

      if (existing) {
        // ── UPDATE path ──────────────────────────────────────────────────
        const newStatus = vstatus !== 'unknown' ? vstatus : 'not-measured';
        const valueChanged =
          existing.value !== processValue(String(value), 'encrypt') ||
          existing.status !== newStatus;

        if (!valueChanged) {
          // Nothing changed — return as-is, skip alert/notification
          return existing;
        }

        existing.value = processValue(String(value), 'encrypt');
        existing.status = newStatus;
        await existing.save();

        savedRecord = existing;
      } else {
        // ── CREATE path ──────────────────────────────────────────────────
        const newRecord = new this.recordModel({
          user: new mongoose.Types.ObjectId(uid),
          recorded_at,
          vital: new mongoose.Types.ObjectId(vital),
          value: processValue(String(value), 'encrypt'),
          status: vstatus !== 'unknown' ? vstatus : 'not-measured',
        });
        await newRecord.save();

        savedRecord = newRecord;
      }

      // ── Alert + Notification (new record OR value actually changed) ───
      if (body.isSaved) {
        await this.addAlert(user, vitalDoc, { value, recorded_at }, vstatus);

        await this.createVitalNotification(user, vitalDoc, value, vstatus);
      }

      return savedRecord;
    } catch (error) {
      console.error('Error in createUpdate:', error?.message);
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
      if (
        vstatus === 'normal' ||
        vstatus === 'unknown' ||
        vstatus === 'not-measured'
      ) {
        await this.alertModel
          .updateOne(
            { user: userId },
            { $pull: { alerts: { vital: vitalDoc.key } } },
          )
          .exec();
        return;
      }

      const msg = getVitalMessage(vitalDoc, body.value, vstatus);

      const alert = {
        vital: vitalDoc.key,
        status: vstatus,
        label: msg.label,
        message: msg.message,
        value: body.value,
        recorded_at: body.recorded_at,
      };

      const result = await this.alertModel.updateOne(
        { user: userId, 'alerts.vital': vitalDoc.key },
        { $set: { 'alerts.$': alert } },
      );

      if (result.matchedCount === 0) {
        await this.alertModel.updateOne(
          { user: userId },
          { $push: { alerts: alert } },
          { upsert: true },
        );
      }
    } catch (error: any) {
      throw new Error(error?.message || 'Failed to add alert');
    }
  }
  async bulkCreateUpdate(req: any): Promise<any> {
    const uid: any = new Types.ObjectId(req.user._id);
    const timezone = req.user?.timezone || 'UTC';
    const { start, end } = getLast24HoursBoundary(timezone);

    // ── 1. Filter to today + dedupe ───────────────────────────────────
    const seenVitals = new Set();

    const todayBodies = (
      Array.isArray(req.body) ? req.body : [req.body]
    ).filter((obj) => {
      // Check if recorded_at is between start (inclusive) and end (exclusive)
      const t = new Date(obj.recorded_at);
      if (t < start || t >= end) return false;

      // Filter unique vital values
      if (seenVitals.has(obj.vital)) return false;
      seenVitals.add(obj.vital);

      return true;
    });

    if (!todayBodies.length) return this.homeRecords({ user: req.user });

    const deduped = dedupeByVital(todayBodies);
    const vitalIds = deduped.map((b) => new Types.ObjectId(b.vital));

    // ── 2. Fetch everything needed in one round-trip ──────────────────
    const [vitalDocs, existingRecords] = await Promise.all([
      this.vitalModel
        .find({ _id: { $in: vitalIds } })
        .lean()
        .exec(),
      this.recordModel.aggregate([
        {
          $match: {
            user: uid,
            vital: { $in: vitalIds },
            recorded_at: { $gte: start, $lt: end },
          },
        },
        {
          $sort: {
            recorded_at: -1,
          },
        },
        {
          $group: {
            _id: '$vital',
            record: { $first: '$$ROOT' },
          },
        },
        {
          $replaceRoot: {
            newRoot: '$record',
          },
        },
      ]),
    ]);

    const vitalMap = new Map(vitalDocs.map((v) => [String(v._id), v]));
    const existingMap = new Map(
      existingRecords.map((r) => [String(r.vital), r]),
    );

    // ── 3. Build ops in memory ────────────────────────────────────────
    const recordOps: any[] = [];
    const alertsToAdd: any[] = [];
    const vitalKeysToWipe: string[] = [];
    const notifications: Promise<any>[] = [];
    const doctorAlerts: any[] = [];

    for (const body of deduped) {
      const vitalDoc: any = vitalMap.get(body.vital);
      if (!vitalDoc) continue;

      body.vstatus = getVitalStatus(vitalDoc?.key, body.value);

      const result = buildRecordOp(body, uid, existingMap.get(body.vital));
      if (!result) continue; // unchanged, skip everything

      recordOps.push(result.op);

      // Doctor alert if: brand new record OR status got worse/changed
      const isAbnormal = !['normal', 'unknown', 'not-measured'].includes(
        body.vstatus,
      );
      if (
        isAbnormal &&
        body.vstatus !== 'medium' &&
        (result.isNew || result.statusChanged)
      ) {
        doctorAlerts.push(body);
      }
      vitalKeysToWipe.push(vitalDoc.key); // always clear old alert

      const alertEntry = buildAlertEntry(vitalDoc, body);
      if (alertEntry) alertsToAdd.push(alertEntry); // re-add if abnormal
      if (isAbnormal) {
        notifications.push(
          this.createVitalNotification(uid, vitalDoc, body.value, body.vstatus),
        );
      }
    }

    // ── 4. Flush writes ───────────────────────────────────────────────
    await Promise.all([
      recordOps.length &&
        this.recordModel.bulkWrite(recordOps, { ordered: false }),
      vitalKeysToWipe.length &&
        this.alertModel.updateOne(
          { user: uid },
          { $pull: { alerts: { vital: { $in: vitalKeysToWipe } } } },
          { upsert: true },
        ),
    ]);

    if (alertsToAdd.length) {
      await this.alertModel.updateOne(
        { user: uid },
        { $push: { alerts: { $each: alertsToAdd } } },
        { upsert: true },
      );
    }

    // ── 5. Fire-and-forget (don't block response) ─────────────────────
    Promise.allSettled(notifications).catch(console.error);
    if (doctorAlerts.length) this.maybeSendDoctorAlert(req.user, doctorAlerts);
    return this.homeRecords({ user: req.user });
  }
  getDateFilter(
    from: string,
    to: string,
    timeFilter: string,
    timezone: string = 'UTC',
  ) {
    let startDate: moment.Moment;
    let endDate: moment.Moment;

    if (from && to) {
      // Include the complete from/to dates
      startDate = moment(from).tz(timezone, true).startOf('day');

      endDate = moment(to).tz(timezone, true).endOf('day');
    } else {
      endDate = moment().tz(timezone);
      switch (timeFilter) {
        case '24hrs':
          startDate = endDate.clone().subtract(26, 'hours');
          break;

        case '7days':
          startDate = endDate.clone().subtract(7, 'days');
          break;

        case '30days':
          startDate = endDate.clone().subtract(30, 'days');
          break;

        default:
          startDate = endDate.clone().startOf('day');
      }
    }
    return {
      startDate: startDate.toDate(),
      now: endDate.toDate(),
    };
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
          status: 'not-measured',
        });
      }
    });
    const mresult = result.map((r: any) => {
      return {
        ...r,
        recorded_at: moment(r.recorded_at)
          .tz(user?.timezone || 'UTC')
          .format(),
      };
    });
    return mresult;
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
        .select('email name image country phone medicalConditions')
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
              status: 'not-measured',
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
  private async maybeSendDoctorAlert(user: any, records: any[]): Promise<void> {
    try {
      const getObjectId = (id: any) => {
        try {
          return new Types.ObjectId(id);
        } catch (error) {
          return null;
        }
      };
      const CRITICAL_STATUSES = ['high', 'low', 'critical'];

      // Pull the user's current alert document
      const alertDoc = await this.alertModel
        .findOne({ user: getObjectId(user._id) })
        .exec();
      if (!alertDoc?.alerts?.length) return;

      const criticalAlerts = alertDoc.alerts.filter((a) =>
        CRITICAL_STATUSES.includes(a.status?.toLowerCase()),
      );
      if (!criticalAlerts.length) return;

      // Fetch the HospitalUser record and populate the hospital details
      const hospitalUser = await this.hospitalUserModel
        .findOne({ user: getObjectId(user._id) })
        .populate('hospital') // populate Hospital document
        .exec();
      if (!hospitalUser) return;
      const hospital: any = hospitalUser?.hospital;
      // Fetch the specialist(s) linked to this user
      const specialists = await this.specialistModel
        .find({ user: getObjectId(user._id) })
        .exec();
      if (!specialists?.length) return;

      // Pick the first specialist for alerting
      const doctor = specialists[0];
      if (!doctor.email) return;

      // Build the alerts payload
      const alertsPayload = alertDoc.alerts.map((a) => ({
        name: a.label ?? a.vital,
        value: a.value,
        recorded_at: a.recorded_at
          ? new Date(a.recorded_at).toISOString()
          : new Date().toISOString(),
        status: (a.status ?? 'UNKNOWN').toUpperCase(),
      }));

      // Send email to the doctor
      await sendEmail({
        to: doctor.email,
        subject: `⚠️ Critical Vitals Alert — ${user.name ?? 'Your Patient'}`,
        type: 'alert',
        data: {
          patient: {
            name: user.name ?? 'Unknown',
            age: user.age ?? null,
            email: user.email ?? '',
          },
          doctor: {
            name: doctor.name ?? '',
            email: doctor.email,
          },
          hospital: {
            name: hospital?.name ?? '',
            location: hospital?.location ?? '',
            areaLevel: hospital?.areaLevel ?? '',
          },
          comment: this.buildCommentFromAlerts(criticalAlerts),
          alerts: alertsPayload,
        },
      });
    } catch (error: any) {
      console.error('maybeSendDoctorAlert error:', error?.message);
    }
  }

  buildCommentFromAlerts(criticalAlerts: any[]): string {
    const names = criticalAlerts.map((a) => `${a.label ?? a.vital}`);
    if (names.length === 1) {
      return `${names[0]} detected — please review the patient's latest vitals.`;
    }
    const last = names.pop();
    return `${names.join(', ')} and ${last} detected — please review the patient's latest vitals.`;
  }
}
