import { DbStore, RepositoryBase } from '@crowd/database'
import { Logger } from '@crowd/logging'
import { IGenerateStreamsData } from './integrationRun.data'
import { IIntegrationStream, IntegrationRunState, IntegrationStreamState } from '@crowd/types'
import { generateUUIDv1 } from '@crowd/common'

export default class IntegrationRunRepository extends RepositoryBase<IntegrationRunRepository> {
  constructor(dbStore: DbStore, parentLog: Logger) {
    super(dbStore, parentLog)
  }

  private readonly getGenerateStreamDataQuery = `
    with stream_count as (select "runId", count(id) as stream_count
                          from integration."runStreams"
                         where "runId" = $(runId)
                         group by "runId")
    select r."integrationId",
          i."integrationIdentifier",
          r."tenantId",
          r.onboarding,
          i.platform                  as "integrationType", 
          i.status                    as "integrationState",
          r.state                     as "runState",
          r.id                        as "runId",
          i.settings                  as "integrationSettings",
          coalesce(c.stream_count, 0) as "streamCount"
      from integration.runs r
              inner join integrations i on (r."integrationId" = i.id and i."deletedAt" is null)
              left join stream_count c on c."runId" = r.id
    where r.id = $(runId);
  `
  public async getGenerateStreamData(runId: string): Promise<IGenerateStreamsData | null> {
    const results = await this.db().oneOrNone(this.getGenerateStreamDataQuery, {
      runId,
    })

    return results
  }

  public async markRunError(runId: string, error: unknown): Promise<void> {
    const result = await this.db().result(
      `update integration.runs
         set state = $(state),
             "processedAt" = now(),
             error = $(error),
             "updatedAt" = now()
       where id = $(runId)`,
      {
        runId,
        state: IntegrationRunState.ERROR,
        error: JSON.stringify(error),
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)
  }

  public async markRunInProgress(runId: string): Promise<void> {
    const result = await this.db().result(
      `
      update integration.runs
         set state = $(state),
            "updatedAt" = now()
       where id = $(runId)
    `,
      {
        runId,
        state: IntegrationRunState.PROCESSING,
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)
  }

  public async touchRun(runId: string): Promise<void> {
    const result = await this.db().result(
      `
      update integration.runs
         set "updatedAt" = now()
       where id = $(runId)
    `,
      {
        runId,
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)
  }

  public async updateIntegrationSettings(runId: string, settings: unknown): Promise<void> {
    const result = await this.db().result(
      `
      update "integrations"
         set settings = settings || $(settings)::jsonb,
            "updatedAt" = now()
       where id = (select "integrationId" from integration.runs where id = $(runId) limit 1)
    `,
      {
        runId,
        settings: JSON.stringify(settings),
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)
  }

  public async publishStream(runId: string, stream: IIntegrationStream): Promise<string> {
    const id = generateUUIDv1()

    const result = await this.db().result(
      `
    insert into integration."runStreams"(id, "runId", state, identifier, type, data, "tenantId", "integrationId", "microserviceId")
    select $(id)::uuid,
           $(runId)::uuid,
           $(state),
           $(identifier),
           $(type),
           $(data)::json,
           "tenantId",
           "integrationId",
           "microserviceId"
    from integration.runs where id = $(runId);
    `,
      {
        id,
        runId,
        state: IntegrationStreamState.PENDING,
        identifier: stream.identifier,
        type: stream.type,
        data: stream.data ? JSON.stringify(stream.data) : null,
      },
    )

    this.checkUpdateRowCount(result.rowCount, 1)

    return id
  }
}
