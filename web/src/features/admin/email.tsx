import { useState } from 'react'
import { useAction, useActionQuery } from '../../lib/api.ts'
import type { ActionInput, ActionOutput } from '../../../../server/registry.ts'
import { Banner, Button, Card, Field, Input, PageHeader, Select, Spinner, Switch, useFeedback } from '../../ui/index.tsx'

type Values = ActionInput<'install.settings.set'>['values']
const fields = {
  ses: [['ses_region', 'AWS region'], ['ses_access_key_id', 'Access key ID'], ['ses_secret_access_key', 'Secret access key'], ['ses_configuration_set', 'Configuration set'], ['ses_sns_topic_arn', 'SNS topic ARN']],
  resend: [['resend_api_key', 'API key'], ['resend_webhook_secret', 'Webhook signing secret']],
  smtp: [['smtp_host', 'SMTP host'], ['smtp_port', 'SMTP port'], ['smtp_security', 'Security (tls, starttls or none)'], ['smtp_user', 'Username'], ['smtp_password', 'Password']],
  test: [],
} satisfies Record<string, [keyof Values, string][]>
const providerName: Record<string, string> = { ses: 'Amazon SES', resend: 'Resend', smtp: 'SMTP' }
const secretField = (key: string) => /(secret|password|api_key|access_key_id|smtp_user)/.test(key)

function EmailForm({ settings }: { settings: ActionOutput<'install.settings.get'> }) {
  const [draft, setDraft] = useState<Values>({})
  const [to, setTo] = useState('')
  const feedback = useFeedback()
  const save = useAction('install.settings.set', { invalidate: ['install.settings.get'], onSuccess: () => { setDraft({}); feedback.toast('Email settings saved') } })
  const test = useAction('install.email.test', { onSuccess: () => feedback.toast('Test email sent') })
  const value = (key: keyof Values) => draft[key] ?? settings.values[key] ?? ''
  const provider = value('email_provider') || 'test'
  const providerFields = provider === 'ses' ? fields.ses : provider === 'resend' ? fields.resend : provider === 'smtp' ? fields.smtp : fields.test
  const set = (key: keyof Values, text: string) => setDraft((current) => ({ ...current, [key]: text }))
  const refused = save.error?.code === 'missing_credentials' ? (save.error.details as { missing?: string[] } | null)?.missing : undefined
  const missing = new Set(refused ?? (draft.email_provider === undefined ? settings.missing : []))
  const renderField = (key: keyof Values, label: string, type = 'text') => <Field key={key} label={label} error={missing.has(key) ? `Required for ${providerName[provider] ?? provider}.` : undefined} hint={settings.fromEnv[key] ? 'Set by environment' : secretField(key) && settings.secretsSet[key] ? 'Saved. Leave blank to keep it.' : undefined}>{(id) => <Input id={id} type={secretField(key) ? 'password' : type} autoComplete={secretField(key) ? 'new-password' : undefined} disabled={settings.fromEnv[key]} value={value(key)} onChange={(e) => set(key, e.target.value)} />}</Field>
  return <div className="flex flex-col gap-5">
    <PageHeader title="Email provider" description="Configure newsletter and system email delivery for this install." />
    {(save.error || test.error) && <Banner kind="danger">{(save.error || test.error)?.message}</Banner>}
    <form onSubmit={(e) => { e.preventDefault(); save.mutate({ values: draft }) }}><Card className="flex flex-col gap-4 p-4">
      <Field label="Provider" hint={settings.fromEnv.email_provider ? 'Set by environment' : undefined}>{(id) => <Select id={id} value={provider} disabled={settings.fromEnv.email_provider} onChange={(e) => set('email_provider', e.target.value)}><option value="test">Test (local outbox)</option><option value="ses">Amazon SES</option><option value="resend">Resend</option><option value="smtp">SMTP (Node build)</option></Select>}</Field>
      <div className="grid gap-4 sm:grid-cols-2">{providerFields.map(([key, label]) => renderField(key, label))}{renderField('email_from', 'System sender address', 'email')}{renderField('email_from_name', 'System sender name')}{renderField('send_rate_per_second', 'Emails per second', 'number')}</div>
      <Switch label="Sending enabled" checked={value('sending_enabled') !== 'false'} disabled={settings.fromEnv.sending_enabled} onChange={(checked) => set('sending_enabled', String(checked))} description={settings.fromEnv.sending_enabled ? 'Set by environment' : 'Pause outbound email for this install.'} />
      <div><Button type="submit" variant="primary" loading={save.isPending}>Save settings</Button></div>
    </Card></form>
    <Card className="flex flex-col gap-3 p-4"><h2 className="font-semibold">Send a test email</h2><p className="text-sm text-fg-3">Save settings first, then send a test message.</p><form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); test.mutate({ to }) }}><Field label="Recipient" className="min-w-0 flex-1">{(id) => <Input id={id} required type="email" value={to} onChange={(e) => setTo(e.target.value)} />}</Field><Button type="submit" loading={test.isPending}>Send test</Button></form></Card>
    <Card className="min-w-0 p-4"><h2 className="mb-3 font-semibold">Webhook URLs</h2><p className="mb-3 text-sm text-fg-3">Paste the SES URL into an AWS SNS HTTPS subscription, or the Resend URL into its webhook settings. For SES, save the allowed SNS topic ARN above.</p>{Object.entries(settings.webhookUrls).map(([name, url]) => <p key={name} className="mb-2 break-all text-sm"><span className="font-medium">{name === 'ses' ? 'Amazon SES' : 'Resend'}: </span><code>{url}</code></p>)}</Card>
  </div>
}

export function EmailSettingsPage() {
  const query = useActionQuery('install.settings.get', {})
  if (query.isPending) return <Spinner />
  if (query.error) return <Banner kind="danger">{query.error.message}</Banner>
  return query.data && <EmailForm settings={query.data} />
}
