import type { ConnectRouter } from '@connectrpc/connect'
import { createConnectHandler } from './router'
import { registerCIService } from './services/ci'
import { registerGitService } from './services/git'
import { registerIssueService } from './services/issue'
import { registerPullService } from './services/pull'
import { registerNotificationService } from './services/notification'
import { registerOrgService } from './services/org'
import { registerReleaseService } from './services/release'
import { registerRepoService } from './services/repo'
import { registerSearchService } from './services/search'
import { registerUserService } from './services/user'
import { registerWikiService } from './services/wiki'
import { registerWebhookService } from './services/webhook'

/** Registers every service. All twelve are implemented. */
export function registerServices(router: ConnectRouter): void {
  registerUserService(router)
  registerRepoService(router)
  registerGitService(router)
  registerIssueService(router)
  registerPullService(router)
  registerCIService(router)
  registerSearchService(router)
  registerOrgService(router)
  registerWebhookService(router)
  registerNotificationService(router)
  registerReleaseService(router)
  registerWikiService(router)
}

export const handleConnect = createConnectHandler(registerServices)

export { API_PREFIX } from './router'
