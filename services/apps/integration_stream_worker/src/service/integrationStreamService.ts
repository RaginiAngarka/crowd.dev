import { singleOrDefault, addSeconds } from '@crowd/common'
import { DbStore } from '@crowd/database'
import { Logger, LoggerBase, getChildLogger } from '@crowd/logging'
import { RedisCache, RedisClient } from '@crowd/redis'
import { DataWorkerSender, StreamWorkerSender } from '../queue'
import IntegrationStreamRepository from '../repo/integrationStream.repo'
import {
  IIntegrationStream,
  IntegrationRunState,
  IntegrationStreamType,
  RateLimitError,
} from '@crowd/types'
import { INTEGRATION_SERVICES, IProcessStreamContext } from '@crowd/integrations'
import { WORKER_SETTINGS } from '../config'

export default class IntegrationStreamService extends LoggerBase {
  private readonly repo: IntegrationStreamRepository

  constructor(
    private readonly redisClient: RedisClient,
    private readonly dataWorkerSender: DataWorkerSender,
    private readonly streamWorkerSender: StreamWorkerSender,
    store: DbStore,
    parentLog: Logger,
  ) {
    super(parentLog)

    this.repo = new IntegrationStreamRepository(store, this.log)
  }

  private async triggerRunError(
    runId: string,
    location: string,
    message: string,
    metadata?: unknown,
  ): Promise<void> {
    await this.repo.markRunError(runId, {
      location,
      message,
      metadata,
    })
  }

  private async triggerStreamError(
    streamId: string,
    location: string,
    message: string,
    metadata?: unknown,
  ): Promise<void> {
    await this.repo.markStreamError(streamId, {
      location,
      message,
      metadata,
    })
  }

  public async processStream(streamId: string): Promise<void> {
    this.log.info({ streamId }, 'Trying to process stream!')

    const streamInfo = await this.repo.getStreamData(streamId)

    if (!streamInfo) {
      this.log.error({ streamId }, 'Stream not found!')
      return
    }

    this.log = getChildLogger(`integration-stream-${streamId}`, this.log, {
      streamId,
      runId: streamInfo.runId,
      onboarding: streamInfo.onboarding,
      type: streamInfo.integrationType,
    })

    if (streamInfo.runState !== IntegrationRunState.PROCESSING) {
      this.log.error({ actualState: streamInfo.runState }, 'Run is not in processing state!')
      await this.triggerStreamError(
        streamId,
        'check-stream-run-state',
        'Run is not in processing state!',
        {
          actualState: streamInfo.runState,
        },
      )
      return
    }

    const integrationService = singleOrDefault(
      INTEGRATION_SERVICES,
      (i) => i.type === streamInfo.integrationType,
    )

    if (!integrationService) {
      this.log.error({ type: streamInfo.integrationType }, 'Could not find integration service!')
      await this.triggerStreamError(
        streamId,
        'check-stream-int-service',
        'Could not find integration service!',
        {
          type: streamInfo.integrationType,
        },
      )
      return
    }

    const cache = new RedisCache(`integration-run-${streamInfo.runId}`, this.redisClient, this.log)

    const context: IProcessStreamContext = {
      onboarding: streamInfo.onboarding,

      integration: {
        id: streamInfo.integrationId,
        identifier: streamInfo.integrationIdentifier,
        platform: streamInfo.integrationType,
        status: streamInfo.integrationState,
        settings: streamInfo.integrationSettings,
      },

      stream: {
        identifier: streamInfo.identifier,
        type: streamInfo.parentId ? IntegrationStreamType.CHILD : IntegrationStreamType.ROOT,
        data: streamInfo.data,
      },

      log: this.log,
      cache,

      publishData: async (data) => {
        await this.publishData(streamInfo.tenantId, streamInfo.runId, streamId, data)
      },
      publishStream: async (identifier, data) => {
        await this.publishStream(streamId, streamInfo.tenantId, streamInfo.runId, identifier, data)
      },
      updateIntegrationSettings: async (settings) => {
        await this.updateIntegrationSettings(streamId, settings)
      },

      abortWithError: async (message: string, metadata?: unknown) => {
        this.log.error({ message }, 'Aborting stream processing with error!')
        await this.triggerStreamError(streamId, 'stream-abort', message, metadata)
      },
      abortRunWithError: async (message: string, metadata?: unknown) => {
        this.log.error({ message }, 'Aborting run with error!')
        await this.triggerRunError(streamInfo.runId, 'stream-run-abort', message, metadata)
      },
    }

    this.log.info('Marking stream as in progress!')
    await this.repo.markStreamInProgress(streamId)

    this.log.info('Processing stream!')
    try {
      await integrationService.processStream(context)
      await this.repo.markStreamProcessed(streamId)
    } catch (err) {
      if (err instanceof RateLimitError) {
        const until = addSeconds(new Date(), err.rateLimitResetSeconds)
        this.log.error(
          { until: until.toISOString() },
          'Rate limit error detected - pausing entire run!',
        )
        await this.repo.resetStream(streamId)
        await this.repo.delayRun(streamInfo.runId, until)
      } else {
        this.log.error(err, 'Error while processing stream!')
        await this.triggerStreamError(
          streamId,
          'stream-process',
          'Error while processing stream!',
          {
            error: err,
          },
        )

        if (streamInfo.retries + 1 <= WORKER_SETTINGS().maxStreamRetries) {
          // delay for #retries * 15 minutes
          const until = addSeconds(new Date(), (streamInfo.retries + 1) * 15 * 60)
          this.log.warn({ until: until.toISOString() }, 'Retrying stream!')
          await this.repo.delayStream(streamId, until)
        } else {
          // stop run because of stream error
          this.log.warn('Reached maximum retries for stream! Stopping the run!')
          await this.triggerRunError(
            streamInfo.runId,
            'stream-run-stop',
            'Stream reached maximum retries!',
            {
              retries: streamInfo.retries + 1,
              maxRetries: WORKER_SETTINGS().maxStreamRetries,
            },
          )
        }
      }
    }
  }

  private async updateIntegrationSettings(streamId: string, settings: unknown): Promise<void> {
    try {
      this.log.debug('Updating integration settings!')
      await this.repo.updateIntegrationSettings(streamId, settings)
    } catch (err) {
      await this.triggerRunError(
        streamId,
        'run-stream-update-settings',
        'Error while updating settings!',
        {
          error: err,
        },
      )
      throw err
    }
  }

  private async publishStream(
    parentId: string,
    tenantId: string,
    runId: string,
    identifier: string,
    data?: unknown,
  ): Promise<void> {
    try {
      this.log.debug('Publishing new child stream!')
      const streamId = await this.repo.publishStream(parentId, runId, identifier, data)
      await this.streamWorkerSender.triggerStreamProcessing(tenantId, streamId)
    } catch (err) {
      await this.triggerRunError(
        runId,
        'run-publish-child-stream',
        'Error while publishing child stream!',
        {
          error: err,
        },
      )
      throw err
    }
  }

  private async publishData(
    tenantId: string,
    runId: string,
    streamId: string,
    data: unknown,
  ): Promise<void> {
    try {
      this.log.debug('Publishing new stream data!')
      const dataId = await this.repo.publishData(streamId, data)
      await this.dataWorkerSender.triggerDataProcessing(tenantId, dataId)
    } catch (err) {
      await this.triggerRunError(
        runId,
        'run-publish-stream-data',
        'Error while publishing stream data!',
        {
          error: err,
        },
      )
      throw err
    }
  }
}