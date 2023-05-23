import { DbColumnSet, DbStore, RepositoryBase } from '@crowd/database'
import { Logger } from '@crowd/logging'
import {
  IDbMember,
  IDbMemberCreateData,
  IDbMemberUpdateData,
  getInsertMemberColumnSet,
  getInsertMemberIdentityColumnSet,
  getSelectMemberColumnSet,
  getUpdateMemberColumnSet,
} from './member.data'
import { IMemberIdentity } from '@crowd/types'
import { generateUUIDv1 } from '@crowd/common'

export default class MemberRepository extends RepositoryBase<MemberRepository> {
  private readonly insertMemberColumnSet: DbColumnSet
  private readonly updateMemberColumnSet: DbColumnSet
  private readonly selectMemberColumnSet: DbColumnSet
  private readonly selectMemberQuery: string

  private readonly insertMemberIdentityColumnSet: DbColumnSet

  constructor(dbStore: DbStore, parentLog: Logger) {
    super(dbStore, parentLog)

    this.insertMemberColumnSet = getInsertMemberColumnSet(this.dbInstance)
    this.updateMemberColumnSet = getUpdateMemberColumnSet(this.dbInstance)
    this.selectMemberColumnSet = getSelectMemberColumnSet(this.dbInstance)

    this.selectMemberQuery = `
      select ${this.selectMemberColumnSet.columns.map((c) => `"${c.name}"`).join(', ')}
      from "members"
    `
    this.insertMemberIdentityColumnSet = getInsertMemberIdentityColumnSet(this.dbInstance)
  }

  public async findMember(
    tenantId: string,
    platform: string,
    username: string,
  ): Promise<IDbMember | null> {
    return await this.db().oneOrNone(
      `${this.selectMemberQuery}
      where "id" in (
        select "memberId" from "memberIdentities"
        where "tenantId" = $(tenantId) and
        "platform" = $(platform) and
        "username" = $(username)
      )
    `,
      {
        tenantId,
        platform,
        username,
      },
    )
  }

  public async findIdentities(
    tenantId: string,
    identities: IMemberIdentity[],
  ): Promise<Map<IMemberIdentity, string>> {
    const identityParams = identities.map((identity) => [identity.platform, identity.username])

    const result = await this.db().any(
      `
      select "memberId", platform, username fom "memberIdentities"
      where "tenantId" = $(tenantId) and (platform, username) = any($(identityParams)::text[][]);
    `,
      {
        tenantId,
        identityParams,
      },
    )

    // Map the result to a Map<IMemberIdentity, string>
    const resultMap = new Map<IMemberIdentity, string>()
    result.forEach((row) => {
      resultMap.set({ platform: row.platform, username: row.username }, row.memberId)
    })

    return resultMap
  }

  public async findById(id: string): Promise<IDbMember | null> {
    return await this.db().oneOrNone(`${this.selectMemberQuery} where id = $(id)`, { id })
  }

  public async create(tenantId: string, data: IDbMemberCreateData): Promise<string> {
    const id = generateUUIDv1()
    const ts = new Date()
    const prepared = RepositoryBase.prepare(
      {
        ...data,
        id,
        tenantId,
        reach: {
          total: -1,
        },
        createdAt: ts,
        updatedAt: ts,
      },
      this.insertMemberColumnSet,
    )
    const query = this.dbInstance.helpers.insert(prepared, this.insertMemberColumnSet)
    await this.db().none(query)
    return id
  }

  public async update(id: string, tenantId: string, data: IDbMemberUpdateData): Promise<void> {
    const prepared = RepositoryBase.prepare(
      { ...data, updatedAt: new Date() },
      this.updateMemberColumnSet,
    )
    const query = this.dbInstance.helpers.update(prepared, this.updateMemberColumnSet)
    const result = await this.db().result(
      `${query} where id = $(id) and "tenantId" = $(tenantId)`,
      {
        id,
        tenantId,
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)
  }

  public async getIdentities(memberId: string, tenantId: string): Promise<IMemberIdentity[]> {
    return await this.db().any(
      `
      select "sourceId", "platform", "username" from "memberIdentities"
      where "memberId" = $(memberId) and "tenantId" = $(tenantId)
    `,
      {
        memberId,
        tenantId,
      },
    )
  }

  public async removeIdentities(
    memberId: string,
    tenantId: string,
    identities: IMemberIdentity[],
  ): Promise<void> {
    const formattedIdentities = identities
      .map((i) => `('${i.platform}', '${i.username}')`)
      .join(', ')

    const query = `delete from "memberIdentities"
      where "memberId" = $(memberId) and
      "tenantId" = $(tenantId) and
      ("platform", "username") in (${formattedIdentities});
    `

    const result = await this.db().result(query, {
      memberId,
      tenantId,
      formattedIdentities,
    })

    this.checkUpdateRowCount(result.rowCount, identities.length)
  }

  public async insertIdentities(
    memberId: string,
    tenantId: string,
    integrationId: string,
    identities: IMemberIdentity[],
  ): Promise<void> {
    const objects = identities.map((i) => {
      return {
        memberId,
        tenantId,
        integrationId,
        platform: i.platform,
        sourceId: i.sourceId,
        username: i.username,
      }
    })

    const preparedObjects = RepositoryBase.prepareBatch(objects, this.insertMemberIdentityColumnSet)
    const query = this.dbInstance.helpers.insert(
      preparedObjects,
      this.insertMemberIdentityColumnSet,
    )
    await this.db().none(query)
  }
}
