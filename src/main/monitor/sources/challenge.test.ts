import { describe, expect, it } from 'vitest'
import { ChallengeError } from '../types'
import { assertNotChallenged } from './challenge'

/** 安静路径：不抛即通过 */
function expectPass(status: number, headers: Record<string, string> | Headers): void {
  expect(() => assertNotChallenged(status, headers)).not.toThrow()
}

describe('assertNotChallenged（挑战双信号矩阵）', () => {
  describe('信号一：HTTP 403（无头也命中）', () => {
    it('403 + 空头 → ChallengeError', () => {
      const error: unknown = (() => {
        try {
          assertNotChallenged(403, {})
        } catch (err) {
          return err
        }
      })()
      expect(error).toBeInstanceOf(ChallengeError)
      expect(error instanceof Error && error.name).toBe('ChallengeError')
      expect(error instanceof Error && error.message).toContain('403')
    })

    it('403 + cf-mitigated 头（双信号同时命中）→ ChallengeError', () => {
      expect(() => assertNotChallenged(403, { 'cf-mitigated': 'challenge' })).toThrow(
        ChallengeError
      )
    })
  })

  describe('信号二：cf-mitigated 头含 challenge（状态码任意）', () => {
    it('200 + cf-mitigated: challenge → ChallengeError', () => {
      expect(() => assertNotChallenged(200, { 'cf-mitigated': 'challenge' })).toThrow(
        ChallengeError
      )
    })

    it('头键大小写不敏感：CF-MITIGATED / Cf-Mitigated 都命中', () => {
      expect(() => assertNotChallenged(200, { 'CF-MITIGATED': 'challenge' })).toThrow(
        ChallengeError
      )
      expect(() => assertNotChallenged(200, { 'Cf-Mitigated': 'challenge' })).toThrow(
        ChallengeError
      )
    })

    it('头值大小写不敏感：Challenge / CHALLENGE 都命中', () => {
      expect(() => assertNotChallenged(200, { 'cf-mitigated': 'Challenge' })).toThrow(
        ChallengeError
      )
      expect(() => assertNotChallenged(200, { 'cf-mitigated': 'CHALLENGE' })).toThrow(
        ChallengeError
      )
    })

    it('非 challenge 的 cf-mitigated 值（如 managed）→ 安静', () => {
      expectPass(200, { 'cf-mitigated': 'managed' })
    })

    it('cf-mitigated 为空串 → 安静', () => {
      expectPass(200, { 'cf-mitigated': '' })
    })
  })

  describe('双信号都不命中 → 安静', () => {
    it('200 + 无关头', () => {
      expectPass(200, {})
      expectPass(200, { 'content-type': 'application/rss+xml', server: 'cloudflare' })
    })

    it('非 403 的非 2xx（500/503/301）不是挑战，交由调用方按普通失败处理', () => {
      expectPass(500, {})
      expectPass(503, {})
      expectPass(301, {})
    })
  })

  describe('标准 Headers 入参形态', () => {
    it('Headers.get 大小写不敏感命中 → ChallengeError', () => {
      expect(() => assertNotChallenged(200, new Headers({ 'CF-Mitigated': 'challenge' }))).toThrow(
        ChallengeError
      )
    })

    it('Headers 无挑战头 → 安静', () => {
      expectPass(200, new Headers({ 'Content-Type': 'text/html' }))
    })

    it('Headers + 403 → ChallengeError', () => {
      expect(() => assertNotChallenged(403, new Headers())).toThrow(ChallengeError)
    })
  })

  it('错误消息带状态码与头值（排障用）', () => {
    try {
      assertNotChallenged(200, { 'cf-mitigated': 'challenge' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ChallengeError)
      expect(err instanceof Error && err.message).toBe(
        'cloudflare challenge: status=200 cf-mitigated=challenge'
      )
    }
  })

  it('403 无头时消息头值显示 (none)', () => {
    try {
      assertNotChallenged(403, {})
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err instanceof Error && err.message).toBe(
        'cloudflare challenge: status=403 cf-mitigated=(none)'
      )
    }
  })
})
