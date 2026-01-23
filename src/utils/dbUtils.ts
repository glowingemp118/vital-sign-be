import { processValue } from './encrptdecrpt';
import { config } from 'dotenv';
config();
const IB_URL = process.env.IB_URL || 'https://placehold.co/40x40?text=';

export const countStatus = () => {
  return [
    {
      $match: { role: { $ne: 'admin' } }, // Exclude admin users from the count
    },
    {
      $group: {
        _id: '$status',
        active: {
          $sum: {
            $cond: [{ $eq: ['$status', 'active'] }, 1, 0],
          },
        },
        inactive: {
          $sum: {
            $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0],
          },
        },
        blocked: {
          $sum: {
            $cond: [{ $eq: ['$status', 'blocked'] }, 1, 0],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        active: 1,
        inactive: 1,
        blocked: 1,
      },
    },
  ];
};

export const paginationPipeline = ({
  pageno = 1,
  limit = parseInt(process.env.ITEMPERPAGE),
}) => {
  const skip = (Number(pageno) - 1) * Number(limit);
  return {
    $facet: {
      metadata: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
          },
        },
      ],
      data: [
        {
          $skip: skip,
        },
        {
          $limit: Number(limit),
        },
      ],
    },
  };
};

export const sort = (format: number = -1) => {
  return { $sort: { createdAt: format } };
};

export const finalRes = ({ pageno = 1, limit, data = [] }) => {
  if (!data || !data.length) {
    return {
      meta: {
        total_pages: 0,
        total_length: 0,
        pageno: Number(pageno),
        limit: 0,
      },
      data: [],
    };
  }
  const hasPagination = Number.isFinite(+limit);

  const total = hasPagination
    ? data?.[0]?.metadata?.[0]?.total ?? 0
    : data.length;

  return {
    meta: {
      total_pages: hasPagination ? Math.ceil(total / (limit || 1)) : 0,
      total_length: total,
      pageno: Number(pageno),
      limit: hasPagination ? Number(limit) : 0,
    },
    data: hasPagination ? data?.[0]?.data ?? [] : data,
  };
};

export const userPipeline = () => {
  return [
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'user',
        pipeline: [
          {
            $project: {
              name: 1,
              email: 1,
              phone: 1,
              hashes: 1,
              image: {
                $concat: [IB_URL, '$image'],
              },
            },
          },
        ],
      },
    },
    {
      $unwind: {
        path: '$user',
        preserveNullAndEmptyArrays: true,
      },
    },
  ];
};

export const specialitiesPipeline = () => {
  return [
    {
      $lookup: {
        from: 'specialities', // Lookup for the user based on the 'user' field in doctor
        localField: 'specialties', // The field in the appointment document
        foreignField: '_id', // The field in the doctors collection
        as: 'specialties',
        pipeline: [
          // {
          //   $match: {
          //     ...(search
          //       ? {
          //           $or: [
          //             {
          //               title: {
          //                 $regex: `.*${search}.*`,
          //                 $options: 'i',
          //               },
          //             },
          //             {
          //               description: {
          //                 $regex: `.*${search}.*`,
          //                 $options: 'i',
          //               },
          //             },
          //           ],
          //         }
          //       : {}),
          //   },
          // },
          {
            $project: {
              title: 1,
              description: 1,
              image: {
                $concat: [IB_URL, '$image'], // Concatenate the base URL with the specialty's image
              },
            },
          },
        ],
      },
    },
    {
      $addFields: {
        specialties: {
          $cond: {
            if: { $isArray: '$specialties' }, // If it's an array
            then: '$specialties', // Leave as is
            else: {
              $arrayElemAt: [
                { $objectToArray: '$specialties' },
                0, // Convert the object to an array and grab the first item
              ],
            },
          },
        },
      },
    },
  ];
};

export const drPipeline = () => {
  return [
    {
      $lookup: {
        from: 'doctors',
        let: { userId: '$doctor' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$user', '$$userId'] },
            },
          },
          {
            $project: {
              timing: 0,
              __v: 0,
            },
          },
          ...userPipeline(),
          ...specialitiesPipeline(),
        ],
        as: 'doctor',
      },
    },
    {
      $unwind: {
        path: '$doctor',
        preserveNullAndEmptyArrays: true,
      },
    },
  ];
};

export const appointmentPipeline = () => {
  return [...userPipeline(), ...drPipeline()];
};

export const reviewsRating = (target: string, showReviews: boolean = false) => {
  return [
    {
      $lookup: {
        from: 'reviews',
        let: { userId: `$${target}` },
        pipeline: [
          { $match: { $expr: { $eq: ['$doctor', '$$userId'] } } },
          ...(showReviews ? userPipeline() : []), // Assuming userPipeline is defined elsewhere
          {
            $project: {
              user: 1,
              review: 1,
              rating: 1,
            },
          },
        ],
        as: 'reviews',
      },
    },
    {
      $addFields: {
        totalReviews: {
          $cond: [{ $isArray: '$reviews' }, { $size: '$reviews' }, 0], // Safely check if reviews is an array
        },
        averageRating: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ['$reviews', []] } }, 0] },
            { $avg: '$reviews.rating' },
            0,
          ], // Safely handle empty or null reviews array
        },
        reviews: showReviews ? '$reviews' : [],
      },
    },
  ];
};

export const searchPipeline = (
  search: string,
  queryFields: Record<string, string[]>,
) => {
  search = search.trim();
  if (!search || !Object.keys(queryFields).length) return [];

  const fields = Object.entries(queryFields).flatMap(([base, keys]) =>
    keys.map((key) => `${base}.${key}`),
  );

  const getsf = (field: string) => {
    if (field.includes('hashes')) {
      return processValue(search, 'hash');
    }
    return search;
  };
  if (!fields.length) return [];
  const sArr = fields.map((field) => ({
    [field]: { $regex: new RegExp(getsf(field), 'i') },
  }));
  const pipeline: any[] = [
    {
      $match: {
        $or: sArr,
      },
    },
  ];
  return pipeline;
};

export const chatPipeline = (userId: any, keyword?: string) => {
  return [
    {
      $match: {
        $or: [{ subjectId: userId }, { objectId: userId }],
      },
    },

    // 2. Identify the other user
    {
      $addFields: {
        otherUserId: {
          $cond: [{ $eq: ['$subjectId', userId] }, '$objectId', '$subjectId'],
        },

        // 3. Is this message unread for me?
        isUnread: {
          $and: [
            { $eq: ['$objectId', userId] }, // message sent to me
            {
              $not: {
                $in: [userId, '$readBy'],
              },
            },
          ],
        },
      },
    },

    // 4. Sort newest first
    { $sort: { createdAt: -1 } },

    // 5. Group by chat
    {
      $group: {
        _id: '$otherUserId',
        message: { $first: '$$ROOT' },
        unreadCount: {
          $sum: {
            $cond: ['$isUnread', 1, 0],
          },
        },
      },
    },

    // 6. Populate other user
    {
      $lookup: {
        from: 'users',
        let: { otherId: '$_id' }, // string
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', { $toObjectId: '$$otherId' }] },
                  ...(keyword
                    ? [
                        {
                          $or: [
                            {
                              $regexMatch: {
                                input: '$name',
                                regex: keyword,
                                options: 'i',
                              },
                            },
                            {
                              $regexMatch: {
                                input: '$hashes.name',
                                regex: keyword,
                                options: 'i',
                              },
                            },
                          ],
                        },
                      ]
                    : []),
                ],
              },
            },
          },
          {
            $project: {
              name: 1,
              email: 1,
              image: { $concat: [IB_URL, '$image'] },
              is_verified: 1,
              status: 1,
              user_type: 1,
            },
          },
        ],
        as: 'otherUser',
      },
    },
    { $unwind: '$otherUser' },

    // 7. Final response
    {
      $project: {
        _id: 0,
        otherUser: 1,
        message: {
          _id: '$message._id',
          content: '$message.content',
          messageType: '$message.messageType',
          status: '$message.status',
          createdAt: '$message.createdAt',
        },
        unreadCount: 1,
      },
    },

    // 8. Sort chats by latest message
    { $sort: { 'message.createdAt': -1 } },
  ];
};
