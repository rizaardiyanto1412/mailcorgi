import { useState, type FormEvent } from 'react'
import { Globe } from 'lucide-react'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, useFeedback } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'
import type { ActionOutput } from '../../../../server/registry.ts'

type Website = ActionOutput<'website.get'>
type Options = Website['settings']
function WebsitePage() {
  useDocumentTitle('Website')
  const { current, account } = useSession()
  if (!current) return <EmptyState title="No newsletter selected" body="Create a newsletter from the switcher to set up its website." />
  if (!account?.owner) return <Banner>Only the account owner can manage the website.</Banner>
  return <WebsiteData key={current.id} newsletterId={current.id} />
}
function WebsiteData({ newsletterId }: { newsletterId: string }) {
  const query = useActionQuery('website.get', { newsletterId })
  if (query.error) return <Banner kind="danger">{query.error.message}</Banner>
  if (!query.data) return <p role="status">Loading website…</p>
  return <WebsiteEditor key={JSON.stringify(query.data)} newsletterId={newsletterId} data={query.data} />
}
function WebsiteEditor({ newsletterId, data }: { newsletterId: string; data: Website }) {
  const { toast } = useFeedback()
  const [options, setOptions] = useState(data.settings)
  const [hostname, setHostname] = useState(data.host.hostname)
  const [social, setSocial] = useState(Object.entries(data.settings.socialLinks).map(([name, url]) => ({ name, url })))
  const [socialError, setSocialError] = useState('')
  const save = useAction('website.update', { invalidate: ['website.get'] })
  const setHost = useAction('website.setHost', { invalidate: ['website.get'] })
  const checkHost = useAction('website.checkHost', { invalidate: ['website.get'] })
  const stats = useActionQuery('website.stats', { newsletterId })
  const update = <K extends keyof Options>(key: K, value: Options[K]) => setOptions((s) => ({ ...s, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const populated = social.filter((s) => s.name || s.url)
    if (populated.some((s) => !s.name.trim() || !/^https?:\/\//.test(s.url)) || new Set(populated.map((s) => s.name.trim())).size !== populated.length) {
      setSocialError('Give each link a different name and an http or https URL.')
      return
    }
    setSocialError('')
    try {
      await save.mutateAsync({ newsletterId, settings: { ...options, socialLinks: Object.fromEntries(populated.map((s) => [s.name.trim(), s.url])) } })
      toast('Website settings saved.')
    } catch {}
  }
  return <div className="flex flex-col gap-5">
    <PageHeader title="Website" description="Your public archive and newsletter home." action={<a className="text-sm text-accent-fg underline" href={data.host.url} target="_blank" rel="noreferrer">Visit website</a>} />
    <Card className="p-5"><form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="font-semibold">Public website</h2>
      {(save.error || socialError) && <Banner kind="danger">{save.error?.message || socialError}</Banner>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.enabled} onChange={(e) => update('enabled', e.target.checked)} />Enable the website</label>
      <p className="text-sm text-fg-3">Turning this off hides the archive and asks search engines to remove it.</p>
      <Field label="Search title" hint="Leave empty to use the newsletter name.">{(id) => <Input id={id} maxLength={160} value={options.seoTitle} onChange={(e) => update('seoTitle', e.target.value)} />}</Field>
      <Field label="Search description">{(id) => <Textarea id={id} maxLength={500} value={options.seoDescription} onChange={(e) => update('seoDescription', e.target.value)} />}</Field>
      <Field label="Favicon URL" hint="Leave empty to use the newsletter icon from newsletter settings.">{(id) => <Input id={id} type="url" value={options.favicon} onChange={(e) => update('favicon', e.target.value)} />}</Field>
      <h2 className="mt-3 font-semibold">Analytics</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Plausible domain">{(id) => <Input id={id} placeholder="news.example.com" pattern="[a-zA-Z0-9.\-]*" value={options.plausible} onChange={(e) => update('plausible', e.target.value)} />}</Field>
        <Field label="Google Analytics id">{(id) => <Input id={id} placeholder="G-XXXXXXXXXX" pattern="G-[A-Z0-9]+" value={options.ga4} onChange={(e) => update('ga4', e.target.value)} />}</Field>
        <Field label="Fathom site id">{(id) => <Input id={id} pattern="[A-Z0-9]*" maxLength={30} value={options.fathom} onChange={(e) => update('fathom', e.target.value)} />}</Field>
        <Field label="Umami Cloud website id">{(id) => <Input id={id} pattern="[a-fA-F0-9\-]*" maxLength={50} value={options.umami} onChange={(e) => update('umami', e.target.value)} />}</Field>
      </div>
      <h2 className="mt-3 font-semibold">Social links</h2>
      {!social.length && <p className="text-sm text-fg-3">No social links. Add a link to show it in the website footer.</p>}
      {social.map((link, index) => <div key={index} className="flex flex-wrap items-end gap-3">
        <Field label="Link name" className="min-w-0 flex-1">{(id) => <Input id={id} required maxLength={50} value={link.name} onChange={(e) => setSocial((s) => s.map((v, i) => i === index ? { ...v, name: e.target.value } : v))} />}</Field>
        <Field label="URL" className="min-w-0 flex-1">{(id) => <Input id={id} required type="url" value={link.url} onChange={(e) => setSocial((s) => s.map((v, i) => i === index ? { ...v, url: e.target.value } : v))} />}</Field>
        <Button onClick={() => setSocial((s) => s.filter((_, i) => i !== index))}>Remove</Button>
      </div>)}
      <div><Button onClick={() => setSocial((s) => [...s, { name: '', url: '' }])}>Add link</Button></div>
      <h2 className="mt-3 font-semibold">Custom code</h2><p className="text-sm text-fg-3">Runs only on your verified custom hostname. Add code only from sources you trust.</p>
      <Field label="Head HTML">{(id) => <Textarea id={id} maxLength={20000} value={options.headCode} onChange={(e) => update('headCode', e.target.value)} />}</Field>
      <Field label="Body HTML">{(id) => <Textarea id={id} maxLength={20000} value={options.bodyCode} onChange={(e) => update('bodyCode', e.target.value)} />}</Field>
      <div><Button type="submit" variant="primary" loading={save.isPending}>Save website</Button></div>
    </form></Card>
    <Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">Custom hostname</h2>
      {(setHost.error || checkHost.error) && <Banner kind="danger">{setHost.error?.message || checkHost.error?.message}</Banner>}
      <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); try { await setHost.mutateAsync({ newsletterId, hostname }); toast(hostname ? 'DNS records are ready.' : 'Custom hostname removed.') } catch {} }}>
        <Field label="Hostname" hint="Use a hostname such as news.example.com. Leave empty to remove it.">{(id) => <Input id={id} maxLength={253} value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase())} />}</Field>
        <div><Button type="submit" loading={setHost.isPending}>Save hostname</Button></div>
      </form>
      {data.host.hostname && <><p role="status" className="text-sm">{data.host.verifiedAt ? 'Verified. Your website uses this hostname.' : 'Waiting for DNS verification. Add both records below.'}</p>
        <div className="overflow-x-auto text-sm"><table className="w-full text-left"><thead><tr><th className="pr-4">Type</th><th className="pr-4">Name</th><th>Value</th></tr></thead><tbody><tr><td className="pr-4">CNAME</td><td className="pr-4">{data.host.cname.name}</td><td>{data.host.cname.value}</td></tr><tr><td className="pr-4">TXT</td><td className="pr-4">{data.host.txt.name}</td><td className="max-w-xs break-all">{data.host.txt.value}</td></tr></tbody></table></div>
        <p className="text-sm text-fg-3">DNS updates can take time. Cloudflare operators must also connect this hostname to the Worker, or configure Cloudflare for SaaS.</p>
        <div><Button loading={checkHost.isPending} onClick={async () => { try { const result = await checkHost.mutateAsync({ newsletterId }); toast(result.verifiedAt ? 'Hostname verified.' : 'Both DNS records must match.', { kind: result.verifiedAt ? 'ok' : 'error' }) } catch {} }}>Check DNS</Button></div></>}
    </Card>
    <Publishing newsletterId={newsletterId} data={data} />
    <Card className="flex flex-col gap-3 p-5"><h2 className="font-semibold">Page views</h2><p className="text-sm text-fg-3">Cookie-free counts exclude bots, prefetches and your signed-in visits.</p>
      {stats.error && <Banner kind="danger">{stats.error.message}</Banner>}
      {stats.isPending ? <p role="status">Loading page views…</p> : !stats.data?.days.some((d) => d.page_views) ? <p className="text-sm text-fg-3">No page views yet. Share your website to get its first readers.</p> : <div className="grid gap-2 sm:grid-cols-2">{stats.data.days.map((day) => <p key={day.day} className="text-sm">{day.day}: {day.page_views} views</p>)}</div>}
    </Card>
  </div>
}
function Publishing({ newsletterId, data }: { newsletterId: string; data: Website }) {
  const authors = useActionQuery('authors.list', { newsletterId })
  const [offset, setOffset] = useState(0)
  const campaigns = useActionQuery('campaigns.list', { newsletterId, status: 'sent', limit: 20, offset })
  const [selected, setSelected] = useState<Website['posts'][number] | null>(null)
  const [editor, setEditor] = useState(0)
  return <>
    {authors.error && <Banner kind="danger">{authors.error.message}</Banner>}
    <Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">Sent issues</h2>{campaigns.error && <Banner kind="danger">{campaigns.error.message}</Banner>}{campaigns.isPending ? <p role="status">Loading issues…</p> : !campaigns.data?.campaigns.length ? <p className="text-sm text-fg-3">No sent issues yet. Send an issue from Campaigns to publish it here.</p> : campaigns.data.campaigns.map((campaign) => <IssueEditor key={campaign.id} campaignId={campaign.id} authors={authors.data?.authors ?? []} />)}{(campaigns.data?.total ?? 0) > 20 && <nav aria-label="Sent issue pages" className="flex justify-between gap-3"><Button disabled={offset === 0} onClick={() => setOffset((v) => Math.max(0, v - 20))}>Newer issues</Button><Button disabled={offset + 20 >= (campaigns.data?.total ?? 0)} onClick={() => setOffset((v) => v + 20)}>Older issues</Button></nav>}</Card>
    <Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">Web-only posts</h2><p className="text-sm text-fg-3">Publish writing on the website without sending an email.</p>{!data.posts.length ? <p className="text-sm text-fg-3">No web-only posts. Write your first post below.</p> : data.posts.map((post) => <div key={post.id} className="flex items-center justify-between gap-3"><span className="min-w-0 break-words text-sm">{post.subject} {!post.web_visible && '(hidden)'}</span><Button onClick={() => { setSelected(post); setEditor((v) => v + 1) }}>Edit</Button></div>)}
      {selected && <Button onClick={() => { setSelected(null); setEditor((v) => v + 1) }}>New post</Button>}
      <PostEditor key={editor} newsletterId={newsletterId} post={selected} authors={authors.data?.authors ?? []} />
    </Card>
  </>
}
type Authors = ActionOutput<'authors.list'>['authors']
function PostEditor({ newsletterId, post, authors }: { newsletterId: string; post: Website['posts'][number] | null; authors: Authors }) {
  const { toast } = useFeedback()
  const [subject, setSubject] = useState(post?.subject ?? '')
  const [slug, setSlug] = useState(post?.slug ?? '')
  const [source, setSource] = useState(post?.source ?? '')
  const [authorId, setAuthor] = useState(post?.author_id ?? '')
  const [visible, setVisible] = useState(post ? !!post.web_visible : true)
  const publish = useAction('website.publishPost', { invalidate: ['website.get'] })
  return <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); try { await publish.mutateAsync({ newsletterId, postId: post?.id, subject, slug, source, authorId: authorId || null, visible }); toast(visible ? 'Post published.' : 'Post saved and hidden.') } catch {} }}>
    {publish.error && <Banner kind="danger">{publish.error.message}</Banner>}
    <Field label="Post title">{(id) => <Input id={id} required maxLength={500} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
    <Field label="Post slug">{(id) => <Input id={id} required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(e) => setSlug(e.target.value)} />}</Field>
    <Field label="Markdown content">{(id) => <Textarea id={id} rows={10} maxLength={1000000} value={source} onChange={(e) => setSource(e.target.value)} />}</Field>
    <AuthorSelect authors={authors} value={authorId} onChange={setAuthor} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />Show on website</label>
    <div><Button type="submit" variant="primary" loading={publish.isPending}>{post ? 'Save post' : 'Publish post'}</Button></div>
  </form>
}
function AuthorSelect({ authors, value, onChange }: { authors: Authors; value: string; onChange(value: string): void }) {
  return <Field label="Author">{(id) => <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">No byline</option>{authors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</Select>}</Field>
}
function IssueEditor({ campaignId, authors }: { campaignId: string; authors: Authors }) {
  const query = useActionQuery('campaigns.get', { campaignId })
  if (query.error) return <Banner kind="danger">{query.error.message}</Banner>
  if (!query.data) return <p role="status">Loading issue…</p>
  if (query.data.kind !== 'issue') return null
  return <IssueForm key={JSON.stringify(query.data)} campaign={query.data} authors={authors} />
}
function IssueForm({ campaign, authors }: { campaign: ActionOutput<'campaigns.get'>; authors: Authors }) {
  const [slug, setSlug] = useState(campaign.slug || campaign.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || campaign.id.replace(/_/g, '-'))
  const [visible, setVisible] = useState(campaign.webVisible)
  const [authorId, setAuthor] = useState(campaign.authorId || '')
  const update = useAction('website.updateIssue', { invalidate: ['campaigns.get'] })
  const { toast } = useFeedback()
  return <form className="flex flex-col gap-3 border-t border-line pt-4" onSubmit={async (e) => { e.preventDefault(); try { await update.mutateAsync({ campaignId: campaign.id, slug, visible, authorId: authorId || null }); toast('Issue publishing saved.') } catch {} }}>
    <h3 className="font-medium">{campaign.subject}</h3>{update.error && <Banner kind="danger">{update.error.message}</Banner>}
    <Field label="Issue slug">{(id) => <Input id={id} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} value={slug} onChange={(e) => setSlug(e.target.value)} />}</Field>
    <AuthorSelect authors={authors} value={authorId} onChange={setAuthor} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />Show on website</label>
    <div><Button type="submit" loading={update.isPending}>Save issue</Button></div>
  </form>
}
export const websiteFeature: Feature = {
  name: 'website',
  nav: [{ to: '/website', label: 'Website', icon: Globe }],
  routes: [{ path: 'website', element: <WebsitePage /> }],
  settings: [{ to: '/settings/website', label: 'Website', icon: Globe }],
  settingsRoutes: [{ path: 'website', element: <WebsitePage /> }],
}
