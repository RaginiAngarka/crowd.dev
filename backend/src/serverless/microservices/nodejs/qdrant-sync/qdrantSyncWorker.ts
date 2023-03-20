import axios from 'axios'
import getUserContext from '../../../../database/utils/getUserContext'
import { IRepositoryOptions } from '../../../../database/repositories/IRepositoryOptions'
import { createServiceChildLogger } from '../../../../utils/logging'
import ActivityRepository from '../../../../database/repositories/activityRepository'
import { QDRANT_SYNC_CONFIG } from '../../../../config'
import SettingsRepository from '../../../../database/repositories/settingsRepository'

const log = createServiceChildLogger('qdrantSyncWorker')

async function embed(activity) {
  const text = `${activity.title || ''} 
  ${activity.body || ''}`
  const response = await axios.post(
    'https://api.openai.com/v1/embeddings',
    {
      input: text,
      model: 'text-embedding-ada-002',
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QDRANT_SYNC_CONFIG.openaiApiKey}`,
      },
    },
  )
  return response.data.data[0].embedding
}

async function upsertPoints(points) {
  try {
    const response = await axios.put(
      `${QDRANT_SYNC_CONFIG.qdrantHost}/collections/${QDRANT_SYNC_CONFIG.qdrantCollection}/points`,
      { points },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': QDRANT_SYNC_CONFIG.qdrantApiKey,
        },
        // params: {
        //   wait: true,
        // },
      },
    )
    return response.data
  } catch (e) {
    log.error('Error while upserting points', e)
    throw e
  }
}

async function qdrantSyncWorker(tenantId): Promise<void> {
  const userContext: IRepositoryOptions = await getUserContext(tenantId)

  const settings = userContext.currentTenant.settings[0].get({ plain: true })
  const isOnboarded = settings.aiSupportSettings?.isOnboarded

  let createdAt
  if (!isOnboarded) {
    settings.aiSupportSettings.isOnboarded = 'in-progress'
    await SettingsRepository.save(settings, userContext)
    // 1970 to isostring
    createdAt = false
  } else {
    // 2h ago to isostring
    createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  }

  const activities = await ActivityRepository.findForQdrant(createdAt, userContext)

  log.info('isOnboarded', isOnboarded)
  log.info('createdAt', createdAt)
  log.info('activities', activities.length)

  // Split the activities list into chunks of N
  const chunkSize = 100
  const chunks = []
  for (let i = 0; i < activities.length; i += chunkSize) {
    chunks.push(activities.slice(i, i + chunkSize))
  }

  for (const chunk of chunks) {
    const points = []
    for (const activity of chunk) {
      points.push({
        id: activity.id.toString(),
        payload: activity,
        vector: await embed(activity),
      })
    }
    log.info(await upsertPoints(points))
  }

  if (!createdAt) {
    settings.aiSupportSettings.isOnboarded = true
    await SettingsRepository.save(settings, userContext)
  }
}

export { qdrantSyncWorker }
