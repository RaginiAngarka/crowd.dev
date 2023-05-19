import axios, { AxiosRequestConfig } from 'axios'
import type { DiscourseConnectionParams } from '../../types/discourseTypes'
import { Logger } from '../../../../utils/logging'
import {
  DiscoursePostsByIdsResponse,
  DiscoursePostsByIdsInput,
} from '../../types/discourseTypes'

const serializeArrayToQueryString = (params: Object) => Object.entries(params)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return value
          .map((val) => `${encodeURIComponent(key)}[]=${encodeURIComponent(val)}`)
          .join('&')
      }
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')

// this methods returns ids of posts in a topic
// then we need to parse each topic individually (can be batched)
export const getDiscoursePostsByIds = async (
  params: DiscourseConnectionParams,
  input: DiscoursePostsByIdsInput,
  logger: Logger,
): Promise<DiscoursePostsByIdsResponse> => {
  logger.info({
    message: 'Fetching posts by ids from Discourse',
    params,
    input,
  })


  const queryParameters = {
    post_ids: input.post_ids,
  }

  const queryString = serializeArrayToQueryString(queryParameters)

  const config: AxiosRequestConfig<any> = {
    method: 'get',
    url: `https://${params.forumHostname}/t/${input.topic_id}/posts.json?${queryString}`,
    headers: {
      'Api-Key': params.apiKey,
      'Api-Username': params.apiUsername,
    },
  }

  try {
    const response = await axios(config)
    return response.data
  } catch (err) {
    logger.error({ err, params, input }, 'Error while getting posts by ids from Discourse ')
    throw err
  }
}