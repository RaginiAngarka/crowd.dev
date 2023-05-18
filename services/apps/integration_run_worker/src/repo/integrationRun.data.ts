import { IntegrationState, IntegrationRunState } from '@crowd/types'

export interface IGenerateStreamsData {
  onboarding: boolean
  integrationId: string
  integrationType: string
  integrationState: IntegrationState
  integrationIdentifier: string | null
  runState: IntegrationRunState
  runId: string
  tenantId: string
  integrationSettings: unknown
  streamCount: number
}
