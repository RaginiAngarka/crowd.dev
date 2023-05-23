import SegmentRepository from '../database/repositories/segmentRepository'
import isFeatureEnabled from '../feature-flags/isFeatureEnabled'
import { FeatureFlag } from '../types/common'
import { SegmentData } from '../types/segmentTypes'

export async function segmentMiddleware(req, res, next) {
  try {
    let segments: SegmentData[] = []
    const segmentRepository = new SegmentRepository(req)

    if (!(await isFeatureEnabled(FeatureFlag.SEGMENTS, req))) {
      // return default segment
      const segments = await segmentRepository.querySubprojects({ limit: 1 })
      req.currentSegments = segments.rows
      next()
      return
    }

    if (req.query.segments) {
      // for get requests, segments will be in query
      segments = await segmentRepository.findInIds(req.query.segments)
    } else if (req.body.segments) {
      // for post and put requests, segments will be in body
      segments = await new SegmentRepository(req).findInIds(req.body.segments)
    } else {
      // TODO:: Return all segments that currentUser has access
    }

    req.currentSegments = segments.filter((s) => SegmentRepository.isSubproject(s))

    next()
  } catch (error) {
    next(error)
  }
}
