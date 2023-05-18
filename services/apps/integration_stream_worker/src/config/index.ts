import { IDatabaseConfig } from '@crowd/database'
import { IRedisConfiguration } from '@crowd/redis'
import { ISqsClientConfig } from '@crowd/sqs'
import config = require('config')

export interface IWorkerSettings {
  maxStreamRetries: number
}

let workerSettings: IWorkerSettings
export const WORKER_SETTINGS = (): IWorkerSettings => {
  if (workerSettings) return workerSettings

  workerSettings = config.get<IWorkerSettings>('worker')
  return workerSettings
}

let sqsConfig: ISqsClientConfig
export const SQS_CONFIG = (): ISqsClientConfig => {
  if (sqsConfig) return sqsConfig

  sqsConfig = config.get<ISqsClientConfig>('sqs')
  return sqsConfig
}

let dbConfig: IDatabaseConfig
export const DB_CONFIG = (): IDatabaseConfig => {
  if (dbConfig) return dbConfig

  dbConfig = config.get<IDatabaseConfig>('db')
  return dbConfig
}

let redisConfig: IRedisConfiguration
export const REDIS_CONFIG = (): IRedisConfiguration => {
  if (redisConfig) return redisConfig

  redisConfig = config.get<IRedisConfiguration>('redis')
  return redisConfig
}