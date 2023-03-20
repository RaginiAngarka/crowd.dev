import sanitizeHtml from 'sanitize-html'
import lodash from 'lodash'
import Sequelize, { QueryTypes } from 'sequelize'
import moment from 'moment'
import SequelizeRepository from './sequelizeRepository'
import AuditLogRepository from './auditLogRepository'
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils'
import Error400 from '../../errors/Error400'
import Error404 from '../../errors/Error404'
import { IRepositoryOptions } from './IRepositoryOptions'
import QueryParser from './filters/queryParser'
import { QueryOutput } from './filters/queryTypes'
import { AttributeData } from '../attributes/attribute'
import MemberRepository from './memberRepository'
import {
  ActivityTypeDisplayProperties,
  ActivityTypeSettings,
  DiscordtoActivityType,
  UNKNOWN_ACTIVITY_TYPE_DISPLAY,
} from '../../types/activityTypes'
import { PlatformType } from '../../types/integrationEnums'

const { Op } = Sequelize

const log: boolean = false

class ActivityRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options)

    const tenant = SequelizeRepository.getCurrentTenant(options)

    const transaction = SequelizeRepository.getTransaction(options)

    // Data and body will be displayed as HTML. We need to sanitize them.
    if (data.body) {
      data.body = sanitizeHtml(data.body).trim()
    }

    if (data.title) {
      data.title = sanitizeHtml(data.title).trim()
    }

    if (data.sentiment) {
      this._validateSentiment(data.sentiment)
    }

    const record = await options.database.activity.create(
      {
        ...lodash.pick(data, [
          'type',
          'timestamp',
          'platform',
          'isKeyAction',
          'score',
          'attributes',
          'channel',
          'body',
          'title',
          'url',
          'sentiment',
          'sourceId',
          'importHash',
        ]),
        memberId: data.member || null,
        parentId: data.parent || null,
        sourceParentId: data.sourceParentId || null,
        conversationId: data.conversationId || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    )

    await record.setTasks(data.tasks || [], {
      transaction,
    })

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options)

    return this.findById(record.id, options)
  }

  /**
   * Check whether sentiment data is valid
   * @param sentimentData Object: {positive: number, negative: number, mixed: number, neutral: number, sentiment: 'positive' | 'negative' | 'mixed' | 'neutral'}
   */
  static _validateSentiment(sentimentData) {
    if (!lodash.isEmpty(sentimentData)) {
      const moods = ['positive', 'negative', 'mixed', 'neutral']
      for (const prop of moods) {
        if (typeof sentimentData[prop] !== 'number') {
          throw new Error400('en', 'activity.error.sentiment.mood')
        }
      }
      if (!moods.includes(sentimentData.label)) {
        throw new Error400('en', 'activity.error.sentiment.label')
      }
      if (typeof sentimentData.sentiment !== 'number') {
        throw new Error('activity.error.sentiment.sentiment')
      }
    }
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options)

    const transaction = SequelizeRepository.getTransaction(options)

    const currentTenant = SequelizeRepository.getCurrentTenant(options)

    let record = await options.database.activity.findOne({
      where: {
        id,
        tenantId: currentTenant.id,
      },
      transaction,
    })

    await record.setTasks(data.tasks || [], {
      transaction,
    })

    if (!record) {
      throw new Error404()
    }

    // Data and body will be displayed as HTML. We need to sanitize them.
    if (data.body) {
      data.body = sanitizeHtml(data.body).trim()
    }
    if (data.title) {
      data.title = sanitizeHtml(data.title).trim()
    }

    if (data.sentiment) {
      this._validateSentiment(data.sentiment)
    }

    record = await record.update(
      {
        ...lodash.pick(data, [
          'type',
          'timestamp',
          'platform',
          'isKeyAction',
          'attributes',
          'channel',
          'body',
          'title',
          'url',
          'sentiment',
          'score',
          'sourceId',
          'importHash',
        ]),
        memberId: data.member || undefined,
        parentId: data.parent || undefined,
        sourceParentId: data.sourceParentId || undefined,
        conversationId: data.conversationId || undefined,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    )

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options)

    return this.findById(record.id, options)
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options)

    const currentTenant = SequelizeRepository.getCurrentTenant(options)

    const record = await options.database.activity.findOne({
      where: {
        id,
        tenantId: currentTenant.id,
      },
      transaction,
    })

    if (!record) {
      throw new Error404()
    }

    await record.destroy({
      transaction,
    })

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options)
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options)

    const include = [
      {
        model: options.database.member,
        as: 'member',
      },
      {
        model: options.database.activity,
        as: 'parent',
      },
    ]

    const currentTenant = SequelizeRepository.getCurrentTenant(options)

    const record = await options.database.activity.findOne({
      where: {
        id,
        tenantId: currentTenant.id,
      },
      include,
      transaction,
    })

    if (!record) {
      throw new Error404()
    }

    return this._populateRelations(record, options)
  }

  /**
   * Find a record in the database given a query.
   * @param query Query to find by
   * @param options Repository options
   * @returns The found record. Null if none is found.
   */
  static async findOne(query, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options)

    const currentTenant = SequelizeRepository.getCurrentTenant(options)

    const record = await options.database.activity.findOne({
      where: {
        tenantId: currentTenant.id,
        ...query,
      },
      transaction,
    })

    return this._populateRelations(record, options)
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    return lodash.get(await this.filterIdsInTenant([id], options), '[0]', null)
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) {
      return []
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(options)

    const where = {
      id: {
        [Op.in]: ids,
      },
      tenantId: currentTenant.id,
    }

    const records = await options.database.activity.findAll({
      attributes: ['id'],
      where,
    })

    return records.map((record) => record.id)
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options)

    const tenant = SequelizeRepository.getCurrentTenant(options)

    return options.database.activity.count({
      where: {
        ...filter,
        tenantId: tenant.id,
      },
      transaction,
    })
  }

  static async findAndCountAll(
    {
      filter = {} as any,
      advancedFilter = null as any,
      limit = 0,
      offset = 0,
      orderBy = '',
      attributesSettings = [] as AttributeData[],
    },
    options: IRepositoryOptions,
  ) {
    // If the advanced filter is empty, we construct it from the query parameter filter
    if (!advancedFilter) {
      advancedFilter = { and: [] }

      if (filter.id) {
        advancedFilter.and.push({
          id: filter.id,
        })
      }

      if (filter.type) {
        advancedFilter.and.push({
          type: {
            textContains: filter.type,
          },
        })
      }

      if (filter.timestampRange) {
        const [start, end] = filter.timestampRange

        if (start !== undefined && start !== null && start !== '') {
          advancedFilter.and.push({
            timestamp: {
              gte: start,
            },
          })
        }

        if (end !== undefined && end !== null && end !== '') {
          advancedFilter.and.push({
            timestamp: {
              lte: end,
            },
          })
        }
      }

      if (filter.platform) {
        advancedFilter.and.push({
          platform: {
            textContains: filter.platform,
          },
        })
      }

      if (filter.member) {
        advancedFilter.and.push({
          memberId: filter.member,
        })
      }

      if (
        filter.isKeyAction === true ||
        filter.isKeyAction === 'true' ||
        filter.isKeyAction === false ||
        filter.isKeyAction === 'false'
      ) {
        advancedFilter.and.push({
          isKeyAction: filter.isKeyAction === true || filter.isKeyAction === 'true',
        })
      }

      if (filter.scoreRange) {
        const [start, end] = filter.scoreRange

        if (start !== undefined && start !== null && start !== '') {
          advancedFilter.and.push({
            score: {
              gte: start,
            },
          })
        }

        if (end !== undefined && end !== null && end !== '') {
          advancedFilter.and.push({
            score: {
              lte: end,
            },
          })
        }
      }

      if (filter.channel) {
        advancedFilter.and.push({
          channel: {
            textContains: filter.channel,
          },
        })
      }

      if (filter.body) {
        advancedFilter.and.push({
          body: {
            textContains: filter.body,
          },
        })
      }

      if (filter.title) {
        advancedFilter.and.push({
          title: {
            textContains: filter.title,
          },
        })
      }

      if (filter.url) {
        advancedFilter.and.push({
          textContains: filter.channel,
        })
      }

      if (filter.sentimentRange) {
        const [start, end] = filter.sentimentRange

        if (start !== undefined && start !== null && start !== '') {
          advancedFilter.and.push({
            sentiment: {
              gte: start,
            },
          })
        }

        if (end !== undefined && end !== null && end !== '') {
          advancedFilter.and.push({
            sentiment: {
              lte: end,
            },
          })
        }
      }

      if (filter.sentimentLabel) {
        advancedFilter.and.push({
          'sentiment.label': filter.sentimentLabel,
        })
      }

      for (const mood of ['positive', 'negative', 'neutral', 'mixed']) {
        if (filter[`${mood}SentimentRange`]) {
          const [start, end] = filter[`${mood}SentimentRange`]

          if (start !== undefined && start !== null && start !== '') {
            advancedFilter.and.push({
              [`sentiment.${mood}`]: {
                gte: start,
              },
            })
          }

          if (end !== undefined && end !== null && end !== '') {
            advancedFilter.and.push({
              [`sentiment.${mood}`]: {
                lte: end,
              },
            })
          }
        }
      }

      if (filter.parent) {
        advancedFilter.and.push({
          parentId: filter.parent,
        })
      }

      if (filter.sourceParentId) {
        advancedFilter.and.push({
          sourceParentId: filter.sourceParentId,
        })
      }

      if (filter.sourceId) {
        advancedFilter.and.push({
          sourceId: filter.sourceId,
        })
      }

      if (filter.conversationId) {
        advancedFilter.and.push({
          conversationId: filter.conversationId,
        })
      }

      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange

        if (start !== undefined && start !== null && start !== '') {
          advancedFilter.and.push({
            createdAt: {
              gte: start,
            },
          })
        }

        if (end !== undefined && end !== null && end !== '') {
          advancedFilter.and.push({
            createdAt: {
              gte: end,
            },
          })
        }
      }
    }

    const memberSequelizeInclude = {
      model: options.database.member,
      as: 'member',
      where: {},
    }

    if (advancedFilter.member) {
      const { dynamicAttributesDefaultNestedFields, dynamicAttributesPlatformNestedFields } =
        await MemberRepository.getDynamicAttributesLiterals(attributesSettings, options)

      const memberQueryParser = new QueryParser(
        {
          nestedFields: {
            ...dynamicAttributesDefaultNestedFields,
            ...dynamicAttributesPlatformNestedFields,
            reach: 'reach.total',
          },
          manyToMany: {
            tags: {
              table: 'members',
              model: 'member',
              relationTable: {
                name: 'memberTags',
                from: 'memberId',
                to: 'tagId',
              },
            },
            organizations: {
              table: 'members',
              model: 'member',
              relationTable: {
                name: 'memberOrganizations',
                from: 'memberId',
                to: 'organizationId',
              },
            },
          },
          customOperators: {
            username: {
              model: 'member',
              column: 'username',
            },
            platform: {
              model: 'member',
              column: 'username',
            },
          },
        },
        options,
      )

      const parsedMemberQuery: QueryOutput = memberQueryParser.parse({
        filter: advancedFilter.member,
        orderBy: orderBy || ['joinedAt_DESC'],
        limit,
        offset,
      })

      memberSequelizeInclude.where = parsedMemberQuery.where ?? {}
      delete advancedFilter.member
    }

    const include = [
      memberSequelizeInclude,
      {
        model: options.database.activity,
        as: 'parent',
      },
    ]

    const parser = new QueryParser(
      {
        nestedFields: {
          sentiment: 'sentiment.sentiment',
        },
        manyToMany: {
          organizations: {
            table: 'activities',
            model: 'activity',
            overrideJoinField: 'memberId',
            relationTable: {
              name: 'memberOrganizations',
              from: 'memberId',
              to: 'organizationId',
            },
          },
        },
      },
      options,
    )

    const parsed: QueryOutput = parser.parse({
      filter: advancedFilter,
      orderBy: orderBy || ['timestamp_DESC'],
      limit,
      offset,
    })

    let {
      rows,
      count, // eslint-disable-line prefer-const
    } = await options.database.activity.findAndCountAll({
      include,
      attributes: [
        ...SequelizeFilterUtils.getLiteralProjectionsOfModel('activity', options.database),
      ],
      ...(parsed.where ? { where: parsed.where } : {}),
      ...(parsed.having ? { having: parsed.having } : {}),
      order: parsed.order,
      limit: parsed.limit,
      offset: parsed.offset,
      transaction: SequelizeRepository.getTransaction(options),
    })

    rows = await this._populateRelationsForRows(rows, options)

    return { rows, count, limit: parsed.limit, offset: parsed.offset }
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options)

    const whereAnd: Array<any> = [
      {
        tenantId: tenant.id,
      },
    ]

    if (query) {
      whereAnd.push({
        [Op.or]: [{ id: SequelizeFilterUtils.uuid(query) }],
      })
    }

    const where = { [Op.and]: whereAnd }

    const records = await options.database.activity.findAll({
      attributes: ['id', 'id'],
      where,
      limit: limit ? Number(limit) : undefined,
      order: [['id', 'ASC']],
    })

    return records.map((record) => ({
      id: record.id,
      label: record.id,
    }))
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    if (log) {
      let values = {}

      if (data) {
        values = {
          ...record.get({ plain: true }),
        }
      }

      await AuditLogRepository.log(
        {
          entityName: 'activity',
          entityId: record.id,
          action,
          values,
        },
        options,
      )
    }
  }

  static getInterpolatableVariables(
    string: string,
    interpolatableVariables: string[] = [],
  ): string[] {
    const interpolationStartIndex = string.indexOf('{')
    const interpolationEndIndex = string.indexOf('}')

    // we don't need processing if there's no opening/closing brackets, or when the string is empty
    if (interpolationStartIndex === -1 || interpolationEndIndex === -1 || string.length === 0) {
      return interpolatableVariables
    }

    const interpolationVariable = string.slice(interpolationStartIndex + 1, interpolationEndIndex)
    interpolatableVariables.push(interpolationVariable)

    return this.getInterpolatableVariables(
      string.slice(interpolationEndIndex + 1),
      interpolatableVariables,
    )
  }

  static interpolateVariables(
    displayOptions: ActivityTypeDisplayProperties,
    activity: any,
  ): ActivityTypeDisplayProperties {
    for (const key of Object.keys(displayOptions)) {
      if (typeof displayOptions[key] === 'string') {
        const displayVariables = this.getInterpolatableVariables(displayOptions[key])

        for (const dv of displayVariables) {
          const coalesceVariables = dv.split('|')
          let replacement = ''

          for (const variable of coalesceVariables) {
            const attribute = this.getAttribute(variable.trim(), activity)

            if (attribute) {
              replacement = attribute
              break
            }
          }

          if (displayOptions.formatter && displayOptions.formatter[dv]) {
            replacement = displayOptions.formatter[dv](replacement)
          }
          displayOptions[key] = displayOptions[key].replace(`{${dv}}`, replacement)
        }
      }
    }

    return displayOptions
  }

  static getAttribute(key: string, activity: any) {
    if (key === 'self') {
      return activity
    }

    const splitted = key.split('.')

    let attribute = activity

    for (const key of splitted) {
      try {
        attribute = attribute[key]
      } catch (error) {
        return null
      }
    }

    return attribute
  }

  static getDisplayOptions(
    activity: any,
    activityTypes: ActivityTypeSettings,
  ): ActivityTypeDisplayProperties {
    if (!activity || !activity.platform || !activity.type) {
      return UNKNOWN_ACTIVITY_TYPE_DISPLAY
    }

    const allActivityTypes = { ...activityTypes.default, ...activityTypes.custom }

    if (
      activity.platform === PlatformType.DISCORD &&
      activity.type === DiscordtoActivityType.MESSAGE &&
      activity.attributes.thread === true
    ) {
      activity.type = DiscordtoActivityType.THREAD_MESSAGE
    }

    // cloning is for getting ready to interpolation
    const displayOptions: ActivityTypeDisplayProperties = allActivityTypes[activity.platform]
      ? lodash.cloneDeep(allActivityTypes[activity.platform][activity.type])
      : null

    if (!displayOptions) {
      // return default display
      return UNKNOWN_ACTIVITY_TYPE_DISPLAY
    }

    return this.interpolateVariables(displayOptions, activity)
  }

  static async _populateRelationsForRows(rows, options: IRepositoryOptions) {
    if (!rows) {
      return rows
    }

    return Promise.all(rows.map((record) => this._populateRelations(record, options)))
  }

  static async _populateRelations(record, options: IRepositoryOptions) {
    if (!record) {
      return record
    }
    const transaction = SequelizeRepository.getTransaction(options)

    const output = record.get({ plain: true })

    const activityTypes = options.currentTenant.settings[0].dataValues
      .activityTypes as ActivityTypeSettings

    // we're cloning because we'll use the same object to do interpolating
    output.display = this.getDisplayOptions(record, activityTypes)

    output.tasks = await record.getTasks({
      transaction,
      joinTableAttributes: [],
    })

    return output
  }

  static async findForQdrant(createdAt, options: IRepositoryOptions) {
    if (!createdAt) {
      // If not send, set to moment(0) and convert to YYYY-MM-DD HH:mm:ss
      createdAt = moment(0).format('YYYY-MM-DD HH:mm:ss')
    }

    const activities = await options.database.sequelize.query(
      `SELECT 
        activities.*,
        members.id AS "memberId",
        members."displayName" AS "memberDisplayName",
        COALESCE((members.attributes->'isTeamMember'->>'default')::boolean, FALSE) AS "isByTeamMember"
      FROM 
        activities
      LEFT JOIN 
        members ON activities."memberId" = members.id
      WHERE 
        (activities.body != '' OR activities.title != '') AND
        activities."tenantId" = '${options.currentTenant.id}' AND
        activities."createdAt" > '${createdAt}'
      `,
      {
        type: QueryTypes.SELECT,
      },
    )
    return activities
  }
}

export default ActivityRepository
