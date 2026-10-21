import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, RenderPropsOf, RenderSurface, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

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

// The world beneath the mod: the engine's answers, and a footer that draws the mode labels as one Text.
// Each model step answers from `steps` (a response by default); a compaction makes its own summary request unless told otherwise.
function world(on: On, opts: { noColor?: boolean; surfaces?: RenderSurface[]; compact?: 'request' | 'skip' | 'reused'; steps?: StepAnswer[] } = {}) {
  const status: Array<string | undefined> = []
  const forks: number[] = []
  const commands: string[] = []
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
  on('model.fork', () => { forks.push(forks.length); return { value: null as never } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['their modes'] }))
  return { status, forks, commands }
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
      // The chip is all it does: no model requests, no commands, no status line.
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
