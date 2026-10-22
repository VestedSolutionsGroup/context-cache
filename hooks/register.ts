import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

// The countdown chip: how long the one-hour prompt cache stays warm, drawn in
// the prompt footer on the terminal and in the desktop app. Its glyph steps in
// 120 steps, every 30 seconds, so it redraws a few times a minute at most.
const TTL_MS = 60 * 60 * 1000
const WARN_FRACTION = 0.2
const RING_STEPS = 120
// Moon phases wane with the hour; NO_COLOR keeps monochrome ring glyphs, since emoji draw in their own colors.
const MOONS = ['🌝', '🌖', '🌗', '🌘', '🌚']
const COLD_MOON = '💀'
const GLYPHS = ['●', '◕', '◑', '◔', '○']
const COLD_GLYPH = '◌'
// A prompt of 🔥 alone, spaces and an emoji variation selector aside, pings the cache instead of starting a turn.
const PING = /^\s*🔥\uFE0F?\s*$/u
const PING_PROMPT = 'Reply with the single word: warm'
const NOTHING_TO_PING = '🔥 Nothing to ping until the next message'

export type State = {
  drawing: boolean
  lastRequestAt: number
  drawn: string | null
}

export function freshState(): State {
  return { drawing: false, lastRequestAt: 0, drawn: null }
}

export type Countdown = { left: number; level: 'warm' | 'warn' | 'cold'; step: number; label: string }

/** Where the cache's one-hour clock stands, or null before the first request. A compaction restarts it. */
export function countdown(s: State, now: number): Countdown | null {
  if (!s.lastRequestAt) return null
  // A clock set back since the last request puts that request ahead of now; an hour is the most there can be.
  const left = Math.min(TTL_MS, s.lastRequestAt + TTL_MS - now)
  const level = left <= 0 ? 'cold' : left <= TTL_MS * WARN_FRACTION ? 'warn' : 'warm'
  const step = left <= 0 ? 0 : Math.ceil(left / TTL_MS * RING_STEPS)
  const label = left <= 0 ? 'Cold' : left <= 59000 ? '0:' + String(Math.ceil(left / 1000)).padStart(2, '0') : Math.ceil(left / 60000) + 'm'
  return { left, level, step, label }
}

/** The chip's glyph: one that empties as the cache cools, a moon phase unless NO_COLOR is set. */
export function ringGlyph(c: Countdown, plain = false): string {
  if (c.level === 'cold') return plain ? COLD_GLYPH : COLD_MOON
  const set = plain ? GLYPHS : MOONS
  const emptied = 1 - c.step / RING_STEPS
  return set[Math.min(set.length - 1, Math.round(emptied * (set.length - 1)))]
}

/** A resumed or forked conversation's cache is as old as its last response; /clear starts one with nothing cached. */
export function seedFromStart(s: State, e: { source: string; seconds_since_last_response?: number }, now: number) {
  if (e.source === 'clear') s.lastRequestAt = 0
  else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
  }
}

/** Whether a ping read the cache: it read the prefix and wrote under a tenth of that, or the prefix had gone. */
export function pingWarmed(r: ModelForkResult | null): boolean {
  if (!r || !('usage' in r)) return false
  return r.usage.cache_read_input_tokens > 0 && r.usage.cache_creation_input_tokens < 0.1 * r.usage.cache_read_input_tokens
}

const tokens = (n: number) => n < 1000 ? String(n) : Math.round(n / 1000) + 'k'

/** The line a 🔥 leaves in place of the prompt: what the ping read and wrote, or why it read nothing. */
export function pingNote(r: ModelForkResult | null): string {
  // Older engines answer null for a fork they did not send.
  if (!r) return '🔥 The ping was not sent'
  if (!('usage' in r)) return NOTHING_TO_PING
  const { cache_read_input_tokens: read, cache_creation_input_tokens: wrote } = r.usage
  if (pingWarmed(r)) return `🔥 Read ${tokens(read)} from the cache: warm for another hour`
  if (read || wrote) return `🔥 Read ${tokens(read)} and wrote ${tokens(wrote)}: the cache had already gone`
  if (r.isAnswered === false && r.reason === 'api-error') return `🔥 The ping failed (${r.status ?? r.error})`
  if (r.isAnswered === false && r.reason === 'aborted') return '🔥 The ping was interrupted'
  return '🔥 The ping read nothing from the cache'
}

/** Redraws when the chip's label or ring changes, then waits for the next change: the next 30-second step, or the next second in the last minute. */
async function tick($: EngineInterface, s: State) {
  const c = countdown(s, await $.clock.now())
  const key = c ? c.level + c.label + c.step : ''
  if (key !== s.drawn) {
    s.drawn = key
    $.ui.invalidate('ui.render')
  }
  const unit = c && c.left > 0 && c.left <= 60000 ? 1000 : 30000
  $.clock.after(c && c.left > 0 ? c.left % unit || unit : unit, () => { void tick($, s) })
}

function drawsChip(surface: string | null): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

/** Starts drawing once a surface that has the footer is here; answers whether NO_COLOR is set. */
async function chipOn($: EngineInterface, s: State): Promise<boolean> {
  s.drawing = true
  const noColor = Boolean(await $.env.get('NO_COLOR'))
  // A reload starts the session again; one ticker is enough.
  if (s.drawn === null) {
    s.drawn = ''
    void tick($, s)
  }
  $.ui.invalidate('ui.render')
  return noColor
}

function redraw($: EngineInterface, s: State) {
  if (s.drawing) $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const s = freshState()
  let noColor = false

  // The label stays in the footer's dim gray until the last fifth of the hour.
  const chipStyle = (c: Countdown) => c.level === 'warn' ? (noColor ? { bold: true } : { color: 'warning' }) : { dimColor: true }

  // The footer, terminal and desktop alike: the countdown chip after Claude Code's mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!drawsChip(e.surface)) return next(e)
    const c = countdown(s, await $.clock.now())
    if (!c) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const chip = Text({ ...chipStyle(c), children: [`${ringGlyph(c, noColor)} ${c.label}`] })
    // A column of space keeps the glyph off whatever the footer draws to its left.
    if (e.props.modes.length === 0) return Box({ marginLeft: 1, children: [chip] })
    const theirs = await next(e)
    return Box({ flexDirection: 'row', alignItems: 'center', children: [theirs, Text({ dimColor: true, children: [' · '] }), chip] })
  })

  // The desktop app hosts the session through the SDK, so session.start sees no surface;
  // the app arrives afterwards as an attached client.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (drawsChip(e.surface) && !s.drawing) noColor = await chipOn($, s)
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // A reload while the desktop is attached starts with no surface of its own; the roster still names it.
    s.drawing = false
    if (drawsChip(e.surface) || (await $.session.surfaces()).some(drawsChip)) noColor = await chipOn($, s)
    return r
  })

  // Resume fields set the clock before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    seedFromStart(s, e, await $.clock.now())
    redraw($, s)
    return r
  })

  // The clock starts when the request goes out, but only a request that got a response counts:
  // one that failed before any (an API error, no connection) left the cache as it was.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const at = await $.clock.now()
    const r = yield* next(e)
    if (r.stopReason !== null || r.usage !== null) s.lastRequestAt = at
    return r
  })

  // The chip restarts with every turn.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // turn.step stamps the exact request time; when no step of a turn that got a response did, the turn's end is the floor.
    if (e.usage && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    redraw($, s)
    return r
  })

  // 🔥 alone keeps the cache warm without a turn: one request over the conversation as last sent reads the whole
  // cache, which restarts its hour, and the 🔥 never enters the conversation. A clock already cold is not pinged,
  // since the ping would pay to write the whole cache again, as the next message will.
  on('prompt.submit', async ($, e, next) => {
    if (!PING.test(e.text) || e.attachments?.length) return next(e)
    const at = await $.clock.now()
    const c = countdown(s, at)
    if (!c) return { drop: NOTHING_TO_PING }
    if (c.level === 'cold') return { drop: '🔥 Not pinged: the cache has gone cold, and a ping would pay to write it again' }
    const r = await $.model.fork({ prompt: PING_PROMPT }).catch(() => null)
    // A request of the main conversation that went out while the ping was out stamped a later time.
    if (pingWarmed(r)) {
      s.lastRequestAt = Math.max(s.lastRequestAt, at)
      redraw($, s)
    }
    return { drop: pingNote(r) }
  })

  // /compact runs no turn, so the chip restarts from the compaction's own summary request rather than waiting for the next turn.
  // A skipped compaction leaves the conversation as it was, a precompute installs nothing, and a compaction that
  // reused a precompute's summary or that a hook answered sent no request: its usage is absent.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && r.messages && r.usage) {
      s.lastRequestAt = await $.clock.now()
      redraw($, s)
    }
    return r
  })
}
