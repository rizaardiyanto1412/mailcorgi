import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, CircleAlert, CircleCheck, LoaderCircle, Lock, X } from 'lucide-react'

export const cx = (...args: (string | false | null | undefined)[]) => args.filter(Boolean).join(' ')

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-card',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-sunken shadow-card',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-on-danger hover:opacity-90 shadow-card',
}
const SIZE = { sm: 'h-7 px-2.5 text-[13px] gap-1.5', md: 'h-8 px-3 text-[13px] gap-1.5', lg: 'h-10 px-4 text-sm gap-2' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50 [&>svg]:size-4', BUTTON[variant], SIZE[size], className)}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

/** A link that looks like a Button. `to` routes inside the app; `href` leaves it (new tab). */
export function LinkButton({ to, href, variant = 'secondary', size = 'md', icon, className, children }: { to?: string; href?: string; variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; className?: string; children: ReactNode }) {
  const classes = cx('inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none [&>svg]:size-4', BUTTON[variant], SIZE[size], className)
  if (href) return <a href={href} target="_blank" rel="noreferrer" className={classes}>{icon}{children}</a>
  return <Link to={to ?? '/'} className={classes}>{icon}{children}</Link>
}

/** A button that opens the file picker. The native file input looks different in every browser and theme. */
export function FileButton({ accept, onFile, disabled, label = 'Choose a file', fileName, id }: { accept: string; onFile: (file: File) => void; disabled?: boolean; label?: string; fileName?: string; id?: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex min-w-0 items-center gap-3">
      <input ref={input} id={id} type="file" accept={accept} className="sr-only" tabIndex={-1} disabled={disabled} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); e.target.value = '' }} />
      <Button disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
      {fileName && <span className="truncate text-[13px] text-fg-3">{fileName}</span>}
    </div>
  )
}

/** The one way back to a parent list, above a detail page's header. */
export const BackLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-fg-3 transition-colors hover:text-fg [&>svg]:size-3.5">
    <ArrowLeft aria-hidden />
    {children}
  </Link>
)

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, active, size = 'md', className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [&>svg]:size-4',
        size === 'sm' ? 'size-7' : 'size-8',
        active && 'bg-accent-soft text-accent-fg hover:bg-accent-soft hover:text-accent-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

// ---------------------------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------------------------

const CONTROL =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-3 transition-shadow focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:bg-sunken disabled:text-fg-3'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(CONTROL, 'h-9', className)} {...rest} />
})
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(CONTROL, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />
})
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2377706a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(CONTROL, 'h-9 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  )
})

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-[13px] text-danger">{error}</p> : hint ? <p className="text-[13px] text-fg-3">{hint}</p> : null}
    </div>
  )
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-line-strong')}>
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {description && <span className="block text-[13px] text-fg-3">{description}</span>}
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Small display pieces
// ---------------------------------------------------------------------------------------------

const AVATAR_COLORS = ['#c2410c', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6']
export const colorFor = (name: string) => AVATAR_COLORS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length]
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)), background: colorFor(name) }}>
      {initials(name)}
    </span>
  )
}

export const Spinner = ({ className }: { className?: string }) => <LoaderCircle className={cx('size-4 animate-spin text-fg-3', className)} aria-label="Loading" />

const BADGE: Record<string, string> = { neutral: 'bg-sunken text-fg-2', ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', accent: 'bg-accent-soft text-accent-fg' }
export const Badge = ({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode; className?: string }) => (
  <span className={cx('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap', BADGE[tone], className)}>{children}</span>
)

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-sunken text-fg-3 [&>svg]:size-5">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-fg-3">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Banner({ kind = 'info', children, action }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const style = { info: 'bg-accent-soft text-accent-fg', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', ok: 'bg-ok-soft text-ok' }[kind]
  const Icon = kind === 'ok' ? CircleCheck : CircleAlert
  return (
    <div role={kind === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', style)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-sunken', className)} aria-hidden />
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors', value === t.id ? 'border-accent text-fg' : 'border-transparent text-fg-3 hover:text-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Table({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-xl border border-line bg-surface shadow-card', className)}>
      <table className="w-full text-left text-sm">
        <thead className="bg-sunken text-xs font-medium text-fg-3 [&_th]:px-3 [&_th]:py-2">{head}</thead>
        <tbody className="[&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Popover and menu
// ---------------------------------------------------------------------------------------------

interface PopoverProps {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' | 'dialog'; ref: RefObject<any> }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  width?: number
  role?: 'menu' | 'dialog'
}

export function Popover({ trigger, children, align = 'start', side = 'bottom', width, role = 'menu' }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const p = panel.current?.getBoundingClientRect()
      if (!a || !p) return
      const gap = 6
      let top = side === 'bottom' ? a.bottom + gap : a.top - p.height - gap
      if (side === 'bottom' && top + p.height > window.innerHeight - 8 && a.top - p.height - gap > 8) top = a.top - p.height - gap
      if (side === 'top' && top < 8) top = a.bottom + gap
      let left = align === 'start' ? a.left : a.right - p.width
      left = Math.min(Math.max(8, left), window.innerWidth - p.width - 8)
      setPos({ top: Math.max(8, top), left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align, side])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        anchor.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <>
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': role, ref: anchor })}
      {open &&
        createPortal(
          <div ref={panel} role={role} className="animate-pop fixed z-50 max-h-[min(420px,calc(100vh-16px))] overflow-y-auto rounded-xl bg-surface p-1 shadow-pop" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, minWidth: 180, visibility: pos && open ? 'visible' : 'hidden' }}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  )
}

export function MenuItem({ icon, children, onSelect, danger, checked, hint, disabled }: { icon?: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean; checked?: boolean; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cx('flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0', danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-hover [&>svg]:text-fg-3')}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
      {checked && <Check className="!text-accent-fg" aria-label="Selected" />}
    </button>
  )
}
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-3">{children}</div>
export const MenuDivider = () => <div className="my-1 h-px bg-line" role="separator" />

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export function Modal({ open, onClose, title, description, children, footer, width = 480 }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select')
    ;(first ?? panel.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
        if (!items.length) return
        const first = items[0]!
        const last = items.at(-1)!
        const inside = panel.current.contains(document.activeElement)
        if (e.shiftKey && (!inside || document.activeElement === first)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="animate-fade fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="animate-pop w-full rounded-2xl bg-surface shadow-pop outline-none" style={{ maxWidth: width }}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-fg-3">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} className="-mt-1 -mr-1">
            <X />
          </IconButton>
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && <div className="flex justify-end gap-2 px-5 pb-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------------------------
// Toasts and confirm dialogs
// ---------------------------------------------------------------------------------------------

interface Toast {
  id: number
  message: string
  kind: 'ok' | 'error'
}
interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  danger?: boolean
}
interface Feedback {
  toast: (message: string, options?: { kind?: 'ok' | 'error' }) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
}
const FeedbackContext = createContext<Feedback>({ toast: () => {}, confirm: async () => false })
export const useFeedback = () => useContext(FeedbackContext)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const nextId = useRef(1)
  const toast = useCallback<Feedback['toast']>((message, options) => {
    const id = nextId.current++
    setToasts((list) => [...list.slice(-2), { id, message, kind: options?.kind ?? 'ok' }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), options?.kind === 'error' ? 7000 : 4000)
  }, [])
  const confirm = useCallback<Feedback['confirm']>((options) => new Promise((resolve) => setPending({ ...options, resolve })), [])
  const answer = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }
  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => answer(false)}
        title={pending?.title ?? ''}
        description={pending?.body}
        width={420}
        footer={
          <>
            <Button onClick={() => answer(false)}>Cancel</Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => answer(true)} autoFocus>
              {pending?.confirmLabel}
            </Button>
          </>
        }
      />
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="animate-toast pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl bg-fg py-2.5 pr-3 pl-3.5 text-[13px] font-medium text-surface shadow-pop">
              {t.kind === 'error' ? <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden /> : <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </FeedbackContext.Provider>
  )
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-surface shadow-card', className)}>{children}</div>
}

/** Shown in place of a page or section the signed-in user's role cannot use. */
export function NoAccess({ title, body }: { title: string; body: ReactNode }) {
  return (
    <Card>
      <EmptyState icon={<Lock />} title={title} body={body} />
    </Card>
  )
}

/** A labelled bar for a value against a limit. Native <progress> ignores the theme in most browsers. */
export function Meter({ value, max, label, tone = 'accent' }: { value: number; max: number; label: string; tone?: 'accent' | 'ok' | 'warn' | 'danger' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const fill = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }[tone]
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 w-full overflow-hidden rounded-full bg-sunken">
      <div className={cx('h-full rounded-full transition-[width]', fill)} style={{ width: `${pct}%` }} />
    </div>
  )
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
const STATUS: Record<string, [string, Tone]> = {
  draft: ['Draft', 'neutral'],
  scheduled: ['Scheduled', 'accent'],
  sending: ['Sending', 'accent'],
  paused: ['Paused', 'warn'],
  sent: ['Sent', 'ok'],
  canceled: ['Canceled', 'neutral'],
  subscribed: ['Subscribed', 'ok'],
  unconfirmed: ['Unconfirmed', 'warn'],
  unsubscribed: ['Unsubscribed', 'neutral'],
  bounced: ['Bounced', 'danger'],
  complained: ['Complained', 'danger'],
  cleaned: ['Cleaned', 'neutral'],
  uploading: ['Uploading', 'accent'],
  queued: ['Queued', 'accent'],
  processing: ['Processing', 'accent'],
  completed: ['Completed', 'ok'],
  stalled: ['Stalled', 'warn'],
  failed: ['Failed', 'danger'],
  pending: ['Pending', 'warn'],
  verified: ['Verified', 'ok'],
  suspended: ['Suspended', 'danger'],
  active: ['Active', 'ok'],
  blocked: ['Blocked', 'danger'],
  owner: ['Owner', 'accent'],
  admin: ['Admin', 'neutral'],
  member: ['Member', 'neutral'],
  delivered: ['Delivered', 'ok'],
  opened: ['Opened', 'ok'],
  clicked: ['Clicked', 'ok'],
  skipped: ['Skipped', 'neutral'],
  unknown: ['Unknown', 'neutral'],
}
/** Sentence-case label for a status value from the server. */
export const statusLabel = (status: string) => STATUS[status]?.[0] ?? (status ? status[0]!.toUpperCase() + status.slice(1).replace(/_/g, ' ') : '')
const SOURCES: Record<string, string> = { manual: 'Added by hand', signup: 'Signup form', api: 'API', test: 'Test' }
/** Readable name for a contact source such as `import:mailchimp`. */
export const sourceLabel = (source: string) => SOURCES[source] ?? (source.startsWith('import:') ? `Import (${source.slice(7)})` : source)

/** One badge style for every status in the app: campaigns, contacts, imports, domains and roles. */
export const StatusBadge = ({ status, className }: { status: string; className?: string }) => (
  <Badge tone={STATUS[status]?.[1] ?? 'neutral'} className={className}>
    {statusLabel(status)}
  </Badge>
)

export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M8 11l8 6 8-6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="7" y="9" width="18" height="14" rx="3" fill="none" stroke="#fff" strokeWidth="2.2" />
    <path d="M10 7l2-3 2 3M18 7l2-3 2 3" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
