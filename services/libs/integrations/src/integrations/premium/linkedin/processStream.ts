import { IntegrationStreamType } from '@crowd/types'
import { IProcessStreamContext, ProcessStreamHandler } from '../../../types'
import { getCommentComments } from './api/commentComments'
import { getMember } from './api/member'
import { getOrganization } from './api/organization'
import { getOrganizationPosts } from './api/organizationPosts'
import { getPostComments } from './api/postComments'
import { getPostReactions } from './api/postReactions'
import { ILinkedInAuthor, LinkedinStreamType } from './types'
import {
  getLinkedInOrganizationId,
  getLinkedInUserId,
  isLinkedInOrganization,
  isLinkedInUser,
} from './utils'

/* eslint-disable @typescript-eslint/no-explicit-any */

const getLastReactionTs = async (
  ctx: IProcessStreamContext,
  postUrnId: string,
): Promise<number | undefined> => {
  const posts = (ctx.integration.settings as any).posts || []
  const cachedPost = posts.find((p) => p.id === postUrnId)
  return cachedPost?.lastReactionTs
}

const getLastCommentTs = async (
  ctx: IProcessStreamContext,
  postUrnId: string,
): Promise<number | undefined> => {
  const posts = (ctx.integration.settings as any).posts || []
  const cachedPost = posts.find((p) => p.id === postUrnId)
  return cachedPost?.lastCommentTs
}

const setLastReactionTs = async (ctx: IProcessStreamContext, postUrnId: string, ts: number) => {
  const posts = (ctx.integration.settings as any).posts || []
  const cachedPost = posts.find((p) => p.id === postUrnId)
  if (cachedPost) {
    cachedPost.lastReactionTs = ts
  } else {
    posts.push({
      id: postUrnId,
      lastReactionTs: ts,
    })
  }

  await ctx.updateIntegrationSettings({
    ...(ctx.integration.settings as any),
    posts,
  })
}

const setLastCommentTs = async (ctx: IProcessStreamContext, postUrnId: string, ts: number) => {
  const posts = (ctx.integration.settings as any).posts || []
  const cachedPost = posts.find((p) => p.id === postUrnId)
  if (cachedPost) {
    cachedPost.lastCommentTs = ts
  } else {
    posts.push({
      id: postUrnId,
      lastCommentTs: ts,
    })
  }

  await ctx.updateIntegrationSettings({
    ...(ctx.integration.settings as any),
    posts,
  })
}

const parseAuthor = async (
  memberUrn: string,
  ctx: IProcessStreamContext,
): Promise<ILinkedInAuthor> => {
  let user: ILinkedInAuthor

  if (isLinkedInUser(memberUrn)) {
    const userId = getLinkedInUserId(memberUrn)
    const userString = await ctx.cache.get(`user-${userId}`)

    if (userString) {
      user = JSON.parse(userString)
    } else {
      const data = await getMember(ctx.serviceSettings.nangoId, userId, ctx)
      user = {
        type: 'user',
        data: {
          ...data,
          userId,
        } as any,
      }
      await ctx.cache.set(`user-${userId}`, JSON.stringify(data), 7 * 24 * 60 * 60) // store for 7 days
    }
  } else if (isLinkedInOrganization(memberUrn)) {
    const userId = getLinkedInOrganizationId(memberUrn)
    const userString = await ctx.cache.get(`user-${userId}`)

    if (userString) {
      user = JSON.parse(userString)
    } else {
      const data = await getOrganization(ctx.serviceSettings.nangoId, userId, ctx)
      user = {
        type: 'organization',
        data: {
          ...data,
          userId,
        } as any,
      }
      await ctx.cache.set(`user-${userId}`, JSON.stringify(data), 7 * 24 * 60 * 60) // store for 7 days
    }
  } else {
    await ctx.abortRunWithError(`Unknown member urn: ${memberUrn}`)
    throw new Error(`Unknown member urn: ${memberUrn}`)
  }

  return user
}

const processRootStream: ProcessStreamHandler = async (ctx) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const organizationUrn = (ctx.stream.data as any).organizationUrn
  let posts = await getOrganizationPosts(ctx.serviceSettings.nangoId, organizationUrn, ctx)

  while (posts.elements.length > 0) {
    for (const post of posts.elements) {
      await ctx.cache.set(`post-${post.urnId}`, JSON.stringify(post), 2 * 24 * 60 * 60) // store for 2 days
      await ctx.publishStream(`${LinkedinStreamType.POST_COMMENTS}-${post.urnId}`, {
        postUrnId: post.urnId,
        postBody: post.body,
      })
      await ctx.publishStream(`${LinkedinStreamType.POST_REACTIONS}-${post.urnId}`, {
        postUrnId: post.urnId,
        postBody: post.body,
      })
    }

    if (posts.start !== undefined) {
      posts = await getOrganizationPosts(
        ctx.serviceSettings.nangoId,
        ctx.stream.identifier,
        ctx,
        posts.start,
      )
    } else {
      break
    }
  }
}

const processPostReactionsStream: ProcessStreamHandler = async (ctx) => {
  const postUrnId = (ctx.stream.data as any).postUrnId
  const postBody = (ctx.stream.data as any).postBody

  let lastReactionTs = await getLastReactionTs(ctx, postUrnId)
  if (!lastReactionTs && !ctx.onboarding) {
    const now = new Date()
    const oneMonthAgo = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    )

    lastReactionTs = oneMonthAgo.valueOf()
  }

  const data = await getPostReactions(
    ctx.serviceSettings.nangoId,
    postUrnId,
    ctx,
    (ctx.stream.data as any).start,
    lastReactionTs,
  )

  const reactions = data.elements

  while (reactions.length > 0) {
    const reaction = reactions.shift()

    if (lastReactionTs === undefined || lastReactionTs < reaction.timestamp) {
      await setLastReactionTs(ctx, postUrnId, reaction.timestamp)
    }

    const author = await parseAuthor(reaction.authorUrn, ctx)

    await ctx.publishData({
      type: 'reaction',
      postUrnId,
      postBody,
      reaction,
      author,
    })
  }

  if (data.start !== undefined) {
    await ctx.publishStream(`${LinkedinStreamType.POST_REACTIONS}-${postUrnId}`, {
      postUrnId,
      start: data.start,
    })
  }
}

const processPostCommentsStream: ProcessStreamHandler = async (ctx) => {
  const postUrnId = (ctx.stream.data as any).postUrnId
  const postBody = (ctx.stream.data as any).postBody

  let lastCommentTs = await getLastCommentTs(ctx, postUrnId)
  if (!lastCommentTs && !ctx.onboarding) {
    const now = new Date()
    const oneMonthAgo = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    )

    lastCommentTs = oneMonthAgo.valueOf()
  }

  const data = await getPostComments(
    ctx.serviceSettings.nangoId,
    postUrnId,
    ctx,
    (ctx.stream.data as any).start,
    lastCommentTs,
  )

  const comments = data.elements

  while (comments.length > 0) {
    const comment = comments.shift()

    if (lastCommentTs === undefined || lastCommentTs < comment.timestamp) {
      await setLastCommentTs(ctx, postUrnId, comment.timestamp)
    }

    const author = await parseAuthor(comment.authorUrn, ctx)

    await ctx.publishData({
      type: 'comment',
      comment,
      postUrnId,
      postBody,
      author,
    })
  }

  if (data.start !== undefined) {
    await ctx.publishStream(`${LinkedinStreamType.POST_COMMENTS}-${postUrnId}`, {
      postUrnId,
      start: data.start,
    })
  }
}

const processCommentCommentsStream: ProcessStreamHandler = async (ctx) => {
  const commentUrnId = (ctx.stream.data as any).commentUrnId
  const postUrnId = (ctx.stream.data as any).postUrnId
  const postBody = (ctx.stream.data as any).postBody

  const data = await getCommentComments(
    ctx.serviceSettings.nangoId,
    commentUrnId,
    ctx,
    (ctx.stream.data as any).start,
  )

  const comments = data.elements

  while (comments.length > 0) {
    const comment = comments.shift()

    const author = await parseAuthor(comment.authorUrn, ctx)

    await ctx.publishData({
      type: 'child_comment',
      parentCommentUrnId: commentUrnId,
      comment,
      postUrnId,
      postBody,
      author,
    })
  }

  if (data.start !== undefined) {
    await ctx.publishStream(`${LinkedinStreamType.COMMENT_COMMENTS}-${commentUrnId}`, {
      commentUrnId,
      start: data.start,
    })
  }
}

const handler: ProcessStreamHandler = async (ctx) => {
  if (ctx.stream.type === IntegrationStreamType.ROOT) {
    await processRootStream(ctx)
  } else {
    if (ctx.stream.identifier.startsWith(LinkedinStreamType.POST_COMMENTS)) {
      await processPostCommentsStream(ctx)
    } else if (ctx.stream.identifier.startsWith(LinkedinStreamType.POST_REACTIONS)) {
      await processPostReactionsStream(ctx)
    } else if (ctx.stream.identifier.startsWith(LinkedinStreamType.COMMENT_COMMENTS)) {
      await processCommentCommentsStream(ctx)
    } else {
      {
        ctx.abortRunWithError(`Unknown child stream identifier: ${ctx.stream.identifier}`)
      }
    }
  }
}

export default handler
