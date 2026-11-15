import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, MinusCircle } from 'lucide-react'
import type { Feature } from '../../app/feature.ts'
import { useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, PageHeader, Spinner } from '../../ui/index.tsx'

const labels: Record<string, { title: string; action: string }> = {
  provider: { title: 'Email provider configured', action: 'Open email settings' },
  testEmail: { title: 'Test email sent', action: 'Send a test' },
  webhooks: { title: 'Delivery events received', action: 'See webhook URLs' },
  sending: { title: 'Sending turned on', action: 'Open email settings' },
  domain: { title: 'Sending domain verified', action: 'Add a domain' },
}

const icons = {
  done: <CheckCircle2 className="size-5 shrink-0 text-ok" aria-hidden />,
  skipped: <MinusCircle className="size-5 shrink-0 text-fg-3" aria-hidden />,
  todo: <Circle className="size-5 shrink-0 text-fg-3" aria-hidden />,
}

/** Install admin checklist. Every item reads live state from the server. */
export function SetupChecklistPage() {
  const query = useActionQuery('setup.checklist', {})
  const done = query.data?.items.filter((item) => item.state !== 'todo').length ?? 0
  return <div className="flex flex-col gap-4">
    <PageHeader title="Setup checklist" description="What this install needs before it sends newsletters." action={<Button loading={query.isFetching} onClick={() => query.refetch()}>Check again</Button>} />
    {query.error && <Banner kind="danger">{query.error.message}</Banner>}
    {query.isPending && <Spinner />}
    {query.data && <>
      {query.data.complete ? <Banner kind="ok">This install is ready to send.</Banner> : <p className="text-sm text-fg-2">{done} of {query.data.items.length} done.</p>}
      <Card className="divide-y divide-line">
        {query.data.items.map((item) => <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {icons[item.state]}
            <div className="min-w-0">
              <p className="font-medium">{labels[item.id]?.title ?? item.id}</p>
              <p className="break-words text-sm text-fg-2">{item.detail}</p>
            </div>
          </div>
          {item.state === 'todo' ? <Link className="text-sm font-medium text-accent-fg hover:underline sm:shrink-0" to={item.href}>{labels[item.id]?.action ?? 'Open'}</Link> : <Badge tone={item.state === 'done' ? 'ok' : 'neutral'}>{item.state === 'done' ? 'Done' : 'Not needed'}</Badge>}
        </div>)}
      </Card>
    </>}
  </div>
}

/** The checklist page mounts inside the admin console at /admin/setup. */
export const setupFeature: Feature = { name: 'setup' }
