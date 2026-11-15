const primes: number[] = []
for (let n = 2; primes.length < 64; n++) if (!primes.some((p) => n % p === 0)) primes.push(n)
const constants = primes.map((p) => (Math.cbrt(p) % 1 * 4294967296) >>> 0)

// The subscription transaction is synchronous on both SQLite drivers.
export function emailHash(email: string): string {
  const bytes = new TextEncoder().encode(email)
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  data.set(bytes)
  data[bytes.length] = 128
  new DataView(data.buffer).setUint32(data.length - 4, bytes.length * 8)
  const h = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1 * 4294967296) >>> 0)
  const rotate = (n: number, k: number) => (n >>> k) | (n << (32 - k))
  const view = new DataView(data.buffer)
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = new Uint32Array(64)
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2]
      w[i] = w[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + w[i]) >>> 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    for (const [i, v] of [a, b, c, d, e, f, g, hh].entries()) h[i] = (h[i] + v) >>> 0
  }
  return h.map((v) => v.toString(16).padStart(8, '0')).join('')
}
