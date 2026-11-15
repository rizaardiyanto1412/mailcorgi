import { useId, useState } from 'react'

export interface ChartPoint { label: string; value: number }
export function Chart({ label, points, kind = 'line' }: { label: string; points: ChartPoint[]; kind?: 'line' | 'bar' | 'sparkline' }) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const width = 600
  const height = kind === 'sparkline' ? 64 : 180
  const max = Math.max(1, ...points.map((p) => p.value))
  const min = Math.min(0, ...points.map((p) => p.value))
  const x = (i: number) => 16 + i * (width - 32) / Math.max(1, points.length - 1)
  const y = (value: number) => height - 24 - (value - min) / (max - min) * (height - 48)
  const point = active === null ? undefined : points[active]
  return <div className="w-full overflow-hidden">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id} className="w-full text-accent-fg" onMouseLeave={() => setActive(null)}>
      <title id={id}>{label}</title>
      <line x1="16" x2="584" y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.15" />
      {kind !== 'bar' && <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />}
      {points.map((p, i) => <g key={`${p.label}-${i}`} tabIndex={0} role="img" aria-label={`${p.label}: ${p.value}`} onFocus={() => setActive(i)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(i)}>
        <title>{p.label}: {p.value.toLocaleString()}</title>
        {kind === 'bar' ? <rect x={x(i) - Math.min(8, 220 / points.length)} y={Math.min(y(p.value), y(0))} width={Math.min(16, 440 / points.length)} height={Math.max(1, Math.abs(y(0) - y(p.value)))} rx="2" fill="currentColor" opacity={active === i ? 1 : 0.65} /> : <circle cx={x(i)} cy={y(p.value)} r={active === i ? 5 : 3} fill="currentColor" />}
      </g>)}
      {point && <text x="300" y="16" textAnchor="middle" fill="currentColor" fontSize="12">{point.label}: {point.value.toLocaleString()}</text>}
    </svg>
    {kind !== 'sparkline' && <div className="flex justify-between text-xs text-fg-3"><span>{points[0]?.label}</span><span>{points.at(-1)?.label}</span></div>}
    {!points.length && <p className="py-4 text-sm text-fg-3">No activity yet. Share your newsletter to start collecting data.</p>}
  </div>
}
