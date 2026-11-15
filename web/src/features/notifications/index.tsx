import { Bell } from 'lucide-react'
import type { Feature } from '../../app/feature.ts'

/** The bell in the sidebar. The notifications unit fills it with an unread count and a list. */
export function NotificationsBell() {
  return (
    <span className="flex size-7 items-center justify-center rounded-md text-fg-3" title="Notifications" aria-label="Notifications">
      <Bell className="size-4" aria-hidden />
    </span>
  )
}

export const notificationsFeature: Feature = { name: 'notifications' }
