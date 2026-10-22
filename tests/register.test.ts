import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { ModelForkResult, ModelUsage, On, PromptSubmitInput, RenderPropsOf, RenderSurface, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { countdown, freshState, ringGlyph, seedFromStart } from '../hooks/register'

tier('user')

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the unrefused arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})
// A turn whose request failed before any response: the engine reports no usage.
const failedTurn = (): TurnCompleteInput => ({ answer: '', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'error' })

const summary = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
const summaryUsage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 4000 }

type StepAnswer = 'response' | 'failed' | 'interrupted'

const prompt = (text: string, over: Partial<PromptSubmitInput> = {}): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' }, ...over })
const pingUsage = (read: number, wrote: number): ModelUsage => ({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: wrote })
// A warm ping reads the conversation's prefix and writes nothing of it.
const warmPing: ModelForkResult = { isAnswered: true, text: 'warm', usage: pingUsage(200000, 0) }
// What a ping may come back as: a fork's result, null as older engines answer, or a refusal to send it.
type PingAnswer = ModelForkResult | null | 'refused'

// The world beneath the mod: the engine's answers, and a footer that draws the mode labels as one Text.
// Each model step answers from `steps` (a response by default); a compaction makes its own summary request unless told otherwise;
// a ping answers from `pings` (a warm one by default).
function world(on: On, opts: { noColor?: boolean; surfaces?: RenderSurface[]; compact?: 'request' | 'skip' | 'reused'; steps?: StepAnswer[]; pings?: PingAnswer[] } = {}) {
  const status: Array<string | undefined> = []
  const forks: number[] = []
  const commands: string[] = []
  const entered: string[] = []
  on('env.get', ($, e) => ({ value: e.name === 'NO_COLOR' && opts.noColor ? '1' : undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? [] }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const answer = opts.steps?.shift() ?? 'response'
    // Every step yields a chunk first, a failed one included: the live engine does.
    yield { kind: 'text' as const, index: 0, text: answer === 'failed' ? 'API Error' : 'hello' }
    // Live, an interrupted response reports no stop reason but its usage; a failed request reports neither.
    return {
      turnId: e.turnId, index: e.index, answer: answer === 'failed' ? '' : 'hello', toolUses: [],
      stopReason: answer === 'response' ? 'end_turn' as const : null,
      usage: answer === 'failed' ? null : usage(),
    }
  })
  on('session.compact', ($, e) => opts.compact === 'skip' ? { skip: 'not now' }
    : opts.compact === 'reused' ? { messages: e.messages }
    : { messages: e.messages, usage: summaryUsage })
  on('classic.SessionStart', () => ({}))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('command.register', ($, e) => { commands.push(e.name); return { value: { command: e.name } } })
  on('model.fork', () => {
    forks.push(forks.length)
    const answer = opts.pings?.length ? opts.pings.shift() : warmPing
    return answer === 'refused' ? { deny: 'not sent' } : { value: answer as ModelForkResult }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['their modes'] }))
  return { status, forks, commands, entered }
}

type Kit = Parameters<TestBody>[0]

const footer = ($: Kit, surface: 'terminal' | 'desktop', modes: string[] = ['plan']) =>
  $.ui.mount({ plugin: 'context-cache', surface, component: 'SessionMode', props: { modes } as unknown as RenderPropsOf['SessionMode'] })

const CHIP = /^\S+ (\d+m|0:\d\d|Cold)$/

const stepInput = (agentId?: string) => ({ turnId: 'step', index: 0, model: 'claude-fable-5-1', messageCount: 1, ...(agentId ? { agentId } : {}) })

async function step($: Kit, agentId?: string) {
  for await (const _ of $.turn.step(stepInput(agentId))) { /* drain */ }
}

describe('the clock', () => {
  test('counts the hour down in minutes, then seconds, then Cold', async () => {
    const s = freshState()
    expect(countdown(s, START)).toBe(null)
    s.lastRequestAt = START
    expect(countdown(s, START)?.label).toBe('60m')
    expect(countdown(s, START + 30 * MIN)?.label).toBe('30m')
    expect(countdown(s, START + 30 * MIN + SEC)?.label).toBe('30m')
    expect(countdown(s, START + 48 * MIN)?.level).toBe('warn')
    expect(countdown(s, START + 47 * MIN)?.level).toBe('warm')
    expect(countdown(s, START + 59 * MIN + 18 * SEC)?.label).toBe('0:42')
    expect(countdown(s, START + HOUR)?.label).toBe('Cold')
    expect(countdown(s, START + HOUR)?.level).toBe('cold')
  })

  test('moon phases wane with the hour; NO_COLOR keeps ring glyphs', async () => {
    const s = freshState()
    s.lastRequestAt = START
    const at = (ms: number, plain = false) => ringGlyph(countdown(s, START + ms)!, plain)
    expect([0, 15 * MIN, 30 * MIN, 45 * MIN, 59 * MIN, HOUR].map(ms => at(ms))).toEqual(['🌝', '🌖', '🌗', '🌘', '🌚', '💀'])
    expect([0, 15 * MIN, 30 * MIN, 45 * MIN, 59 * MIN, HOUR].map(ms => at(ms, true))).toEqual(['●', '◕', '◑', '◔', '○', '◌'])
  })

  test('a request stamped ahead of now, after the clock was set back, reads a full hour', async () => {
    const s = freshState()
    s.lastRequestAt = START + 10 * MIN
    const c = countdown(s, START)!
    expect(c.label).toBe('60m')
    expect(ringGlyph(c)).toBe('🌝')
    expect(ringGlyph(c, true)).toBe('●')
  })

  test('a resume or fork starts the clock at its last response; /clear stops it; a new session leaves it', async () => {
    const s = freshState()
    seedFromStart(s, { source: 'resume', seconds_since_last_response: 30 * 60 }, START)
    expect(s.lastRequestAt).toBe(START - 30 * MIN)
    seedFromStart(s, { source: 'startup' }, START)
    expect(s.lastRequestAt).toBe(START - 30 * MIN)
    seedFromStart(s, { source: 'fork', seconds_since_last_response: 60 }, START)
    expect(s.lastRequestAt).toBe(START - MIN)
    seedFromStart(s, { source: 'clear' }, START)
    expect(s.lastRequestAt).toBe(0)
  })
})

describe('countdown chip', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface} footer: hidden before the first request, then counts the hour down to Cold`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on)
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface)
      expect(await ui.find({ type: 'Text', text: CHIP })).toBe(undefined)
      await $.turn.complete(turn())
      const chip = async () => ui.find({ type: 'Text', text: CHIP })
      expect((await chip())?.text).toBe('🌝 60m')
      expect((await chip())?.props.dimColor).toBe(true)
      expect((await ui.find({ text: /^their modes$/ }))?.text).toBe('their modes')
      expect((await ui.find({ type: 'Text', text: /^ · $/ }))?.text).toBe(' · ')
      await clock.advance(30 * MIN)
      expect((await chip())?.text).toBe('🌗 30m')
      await clock.advance(18 * MIN)
      expect((await chip())?.text).toBe('🌘 12m')
      expect((await chip())?.props.color).toBe('warning')
      await clock.advance(11 * MIN + 18 * SEC)
      expect((await chip())?.text).toBe('🌚 0:42')
      await clock.advance(MIN)
      expect((await chip())?.text).toBe('💀 Cold')
      expect((await chip())?.props.dimColor).toBe(true)
      await $.turn.complete(turn())
      expect((await chip())?.text).toBe('🌝 60m')
      // Short of a 🔥, the chip is all it does: no model requests, no commands, no status line.
      expect(w.forks.length).toBe(0)
      expect(w.commands).toEqual([])
      expect(w.status).toEqual([])
    })

    test(`${surface} footer: with no mode labels the chip stands alone`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on)
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface, [])
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: '🌝 60m' }))?.text).toBe('🌝 60m')
      expect((await ui.find({ type: 'Box' }))?.props.marginLeft).toBe(1)
      expect(await ui.find({ type: 'Text', text: /^ · $/ })).toBe(undefined)
      expect(await ui.find({ text: /^their modes$/ })).toBe(undefined)
    })

    test(`${surface} footer: NO_COLOR keeps monochrome ring glyphs and a bold warning`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: '● 60m' }))?.text).toBe('● 60m')
      await clock.advance(50 * MIN)
      expect((await ui.find({ type: 'Text', text: '◔ 10m' }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: '◔ 10m' }))?.props.color).toBe(undefined)
      await clock.advance(10 * MIN)
      expect((await ui.find({ type: 'Text', text: '◌ Cold' }))?.text).toBe('◌ Cold')
    })

    test(`${surface}: compaction restarts the chip at 60m without waiting for a turn`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on)
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface, [])
      await $.turn.complete(turn())
      await clock.advance(40 * MIN)
      expect((await ui.find({ type: 'Text', text: '🌘 20m' }))?.text).toBe('🌘 20m')
      await $.session.compact({ trigger: 'manual', messages: summary })
      expect((await ui.find({ type: 'Text', text: '🌝 60m' }))?.text).toBe('🌝 60m')
      // A subagent's compaction, and a precompute that installs nothing, leave the main clock alone.
      await clock.advance(10 * MIN)
      await $.session.compact({ trigger: 'auto', agentId: 'worker', messages: summary })
      await $.session.compact({ trigger: 'precompute', messages: summary })
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌖 50m')
      // The engine's own compaction at its threshold restarts it too.
      await $.session.compact({ trigger: 'auto', messages: summary })
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 60m')
      // With no turn after it, the restarted hour still lapses.
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('💀 Cold')
    })

    test(`${surface}: a skipped compaction leaves the clock as it was`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, { compact: 'skip' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface, [])
      await $.turn.complete(turn())
      await clock.advance(40 * MIN)
      await $.session.compact({ trigger: 'manual', messages: summary })
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌘 20m')
    })
  }

  test('a compaction that sent no request of its own (a reused precompute, a hook) leaves the clock as it was', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { compact: 'reused' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    await $.session.compact({ trigger: 'manual', messages: summary })
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌘 10m')
  })

  test('the clock starts when the request goes out, not when its response ends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    const stream = $.turn.step(stepInput())
    await stream.next()
    // Five minutes of response arrive after the request went out.
    await clock.advance(5 * MIN)
    for await (const _ of stream) { /* drain */ }
    await $.turn.complete(turn({ durationMs: 6 * MIN }))
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 55m')
  })

  test('subagent steps and turns leave the main clock alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await step($)
    await clock.advance(10 * MIN)
    await $.turn.complete(turn({ durationMs: 11 * MIN }))
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌖 50m')
    await clock.advance(10 * MIN)
    await step($, 'worker')
    await $.turn.complete(turn({ agentId: 'worker' }))
    // A minute on, the ticker has redrawn from whatever the clock now holds.
    await clock.advance(MIN)
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌖 39m')
  })

  test('a request that failed before any response leaves the clock as it was; an interrupted response restarts it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { steps: ['response', 'failed', 'interrupted'] })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await step($)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌚 5m')
    // No connection, or the API's errors until the retries ran out.
    await step($)
    await $.turn.complete(failedTurn())
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌚 5m')
    // Esc while the answer streams: the request read the cache.
    await step($)
    await $.turn.complete({ ...failedTurn(), reason: 'aborted', isAborted: true })
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 60m')
  })

  test('a turn that failed before any step leaves the clock as it was', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.turn.complete(failedTurn())
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌗 30m')
  })

  test('a warm resume shows the time left before any turn; a cold one shows Cold; /clear hides it', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60 })
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌗 30m')
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200 })
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('💀 Cold')
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ type: 'Text', text: CHIP })).toBe(undefined)
  })

  test('desktop as the app hosts it: no surface at start, the chip turns on when the app attaches', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { noColor: true })
    await $.session.start({ ...session, surface: null, isInteractive: false })
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    // Mounted before the turn, the footer shows the chip only if the attach turned redrawing on, and the ring glyph only if it read NO_COLOR.
    const ui = await footer($, 'desktop', [])
    expect(await ui.find({ type: 'Text', text: CHIP })).toBe(undefined)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('● 60m')
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('◑ 30m')
  })

  test('desktop: a reload while the app is attached keeps the chip', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: ['desktop'], noColor: true })
    await $.session.start({ ...session, surface: null, isInteractive: false })
    const ui = await footer($, 'desktop', [])
    await $.turn.complete(turn())
    // NO_COLOR was read at start, so the roster turned the chip on without an attach.
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('● 60m')
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('◑ 30m')
  })
})

describe('🔥 ping', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 🔥 alone pings the cache and restarts the clock without a turn`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on)
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await footer($, surface, [])
      await $.turn.complete(turn())
      await clock.advance(50 * MIN)
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌘 10m')
      expect((await $.prompt.submit(prompt('🔥'))).drop).toBe('🔥 Read 200k from the cache: warm for another hour')
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 60m')
      // Spaces, and the variation selector some keyboards add, make no other prompt of it.
      await clock.advance(40 * MIN)
      expect((await $.prompt.submit(prompt(' 🔥\uFE0F\n'))).drop).toBe('🔥 Read 200k from the cache: warm for another hour')
      expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 60m')
      // Neither 🔥 reached the conversation.
      expect(w.forks.length).toBe(2)
      expect(w.entered).toEqual([])
    })
  }

  test('🔥 among other words, or with an image, is an ordinary prompt', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    for (const text of ['🔥 keep going', '🔥🔥', 'fire']) expect((await $.prompt.submit(prompt(text))).text).toBe(text)
    expect((await $.prompt.submit(prompt('🔥', { attachments: [{ type: 'image', mediaType: 'image/png' }] }))).text).toBe('🔥')
    expect(w.entered).toEqual(['🔥 keep going', '🔥🔥', 'fire', '🔥'])
    expect(w.forks.length).toBe(0)
  })

  test('a ping that found the cache gone, failed or was not sent leaves the clock as it was', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { pings: [
      { isAnswered: true, text: 'warm', usage: pingUsage(0, 200000) },
      { isAnswered: true, text: 'warm', usage: pingUsage(150000, 50000) },
      { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: pingUsage(0, 0) },
      { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: pingUsage(0, 0) },
      { isAnswered: false, reason: 'aborted', usage: pingUsage(0, 0) },
      { isAnswered: false, reason: 'nothing-to-fork' },
      null,
      'refused',
    ] })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    const drops: Array<string | undefined> = []
    for (let i = 0; i < 8; i++) drops.push((await $.prompt.submit(prompt('🔥'))).drop)
    expect(drops).toEqual([
      '🔥 Read 0 and wrote 200k: the cache had already gone',
      '🔥 Read 150k and wrote 50k: the cache had already gone',
      '🔥 The ping failed (529)',
      '🔥 The ping failed (unknown)',
      '🔥 The ping was interrupted',
      '🔥 Nothing to ping until the next message',
      '🔥 The ping was not sent',
      '🔥 The ping was not sent',
    ])
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌘 20m')
    expect(w.entered).toEqual([])
  })

  test('a ping that read the cache before its request failed still restarts the clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { pings: [{ isAnswered: false, reason: 'empty-reply', usage: pingUsage(200000, 0) }] })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect((await $.prompt.submit(prompt('🔥'))).drop).toBe('🔥 Read 200k from the cache: warm for another hour')
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('🌝 60m')
  })

  test('a clock with nothing on it, or already cold, is not pinged', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await footer($, 'terminal', [])
    expect((await $.prompt.submit(prompt('🔥'))).drop).toBe('🔥 Nothing to ping until the next message')
    await $.turn.complete(turn())
    await clock.advance(HOUR)
    expect((await $.prompt.submit(prompt('🔥'))).drop).toBe('🔥 Not pinged: the cache has gone cold, and a ping would pay to write it again')
    expect((await ui.find({ type: 'Text', text: CHIP }))?.text).toBe('💀 Cold')
    expect(w.forks.length).toBe(0)
    expect(w.entered).toEqual([])
  })
})
