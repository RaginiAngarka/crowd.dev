import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from '@temporalio/client'
import { svc } from '../main'
import { triggerTenantOrganizationEnrichment } from '../workflows'

export const scheduleOrganizationsEnrichment = async () => {
  try {
    await svc.temporal.schedule.create({
      scheduleId: 'organizations-enrichment',
      spec: {
        // every hour (at minute 0)
        cronExpressions: ['0 * * * *'],
      },
      policies: {
        overlap: ScheduleOverlapPolicy.BUFFER_ONE,
        catchupWindow: '1 minute',
      },
      action: {
        type: 'startWorkflow',
        workflowType: triggerTenantOrganizationEnrichment,
        taskQueue: 'organizations-enrichment',
        workflowExecutionTimeout: '5 minutes',
      },
    })
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      svc.log.info('Schedule already registered in Temporal.')
      svc.log.info('Configuration may have changed since. Please make sure they are in sync.')
    } else {
      throw new Error(err)
    }
  }
}
