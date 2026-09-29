import { describe, expect, it } from 'vitest'
import { isOpenStage, scoreLead, OPEN_STAGES } from '../src/services/leads.js'
import { LeadStage } from '../src/generated/client/enums.js'

describe('scoreLead', () => {
  it('is deterministic for identical input', () => {
    // The frontend used `60 + Math.random() * 40`, which reordered the dialer
    // queue on every page load. Same input must always give the same score.
    const input = {
      email: 'a@b.com', title: 'VP', company: 'X',
      source: 'Referral', valueCents: 2_400_000, timezone: 'PT', agentTimezone: 'PT',
    }
    expect(scoreLead(input)).toBe(scoreLead(input))
  })

  it('stays within 0-100', () => {
    const max = scoreLead({
      email: 'a@b.com', title: 'VP', company: 'X', source: 'Referral',
      valueCents: 10_000_000_000, timezone: 'PT', agentTimezone: 'PT',
    })
    const min = scoreLead({})
    expect(max).toBeLessThanOrEqual(100)
    expect(min).toBeGreaterThanOrEqual(0)
  })

  it('ranks a complete record above a bare one', () => {
    const rich = scoreLead({
      email: 'a@b.com', title: 'VP', company: 'X', source: 'Referral', valueCents: 2_400_000,
    })
    const bare = scoreLead({ phone: 'x' } as never)
    expect(rich).toBeGreaterThan(bare)
  })

  it('rewards reaching the lead in the agent own timezone', () => {
    const same = scoreLead({ timezone: 'PT', agentTimezone: 'PT' })
    const different = scoreLead({ timezone: 'JST', agentTimezone: 'PT' })
    expect(same).toBeGreaterThan(different)
  })

  it('gives partial credit for a nearby timezone', () => {
    const near = scoreLead({ timezone: 'ET', agentTimezone: 'PT' })
    const far = scoreLead({ timezone: 'IST', agentTimezone: 'PT' })
    expect(near).toBeGreaterThan(far)
  })

  it('scales with value without letting one huge deal run away', () => {
    // The property that matters: a 100x larger deal must not score 100x
    // higher, or a single outlier monopolises the top of the dialer queue.
    const small = scoreLead({ valueCents: 100_000 }) // $1,000
    const large = scoreLead({ valueCents: 10_000_000 }) // $100,000

    expect(large).toBeGreaterThan(small)
    expect(large - small).toBeLessThanOrEqual(6)
  })

  it('keeps a very large deal inside the 0-100 range', () => {
    const huge = scoreLead({ valueCents: 5_000_000_000 }) // $50M
    expect(huge).toBeLessThanOrEqual(100)
    expect(huge).toBeGreaterThan(scoreLead({ valueCents: 10_000_000 }))
  })

  it('ranks referral above cold call', () => {
    expect(scoreLead({ source: 'Referral' })).toBeGreaterThan(scoreLead({ source: 'Cold call' }))
  })
})

describe('isOpenStage', () => {
  it('treats won and lost as closed', () => {
    expect(isOpenStage(LeadStage.won)).toBe(false)
    expect(isOpenStage(LeadStage.lost)).toBe(false)
  })

  it('treats every working stage as open', () => {
    for (const stage of OPEN_STAGES) {
      expect(isOpenStage(stage)).toBe(true)
    }
  })
})
