import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it } from 'vitest'
import { digest } from '../../src/domain/planning.js'
import { createStore } from '../../src/client/store.js'
import { throughExperienceRpcCarrier } from '../fixtures/client-rpc.js'
import { retrievalProjection } from '../fixtures/retrieval.js'
import type { LearningPredictionView } from '../../src/types.js'

it('binds Browser review to the displayed Host digest and requires receipt readback before success', async () => {
  const calls: Array<{ endpoint: string; payload: any }> = []
  const row = { predictionId: 'prediction-1', prediction: { ranking: { mode: 'shadow', sourceUsageIds: ['usage-1'], nested: { z: 1, a: 2 } } } } as unknown as LearningPredictionView
  const learning = { projectionKey: 'experience-learning-v1', builderVersion: 'm7-learning-v4', rows: [row] }
  let rejectReceipt = false
  const connection = { rpc: { call: async (_channel: string, endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    let value: unknown = {}
    if (endpoint === 'status/query') value = { principalId: 'p', actor: { actorId: 'a' }, candidateCount: 0, versionCount: 0 }
    if (endpoint === 'suggestions/query') value = {
      projectionKey: 'experience-suggestions-v1', schemaVersion: 5,
      groups: [], sessions: [], seeds: [], dispositions: [],
    }
    if (endpoint === 'retrieval/query') value = retrievalProjection()
    if (endpoint === 'candidate/list' || endpoint === 'plan/list') value = []
    if (endpoint === 'learning/query') value = learning
    if (endpoint === 'learning/governance') value = { contracts: [], evaluations: [], capabilities: [] }
    if (endpoint === 'learning/ranking-review') value = { receiptId: 'receipt-1' }
    if (endpoint === 'receipt/get') {
      if (rejectReceipt) return { ok: false, error: { code: 'unavailable', message: 'readback failed' } }
      value = { receiptId: 'receipt-1', capability: 'history_ranking', predictionId: 'prediction-1' }
    }
    return { ok: true, value }
  } } } as unknown as ConnectionHandle
  const store = createStore(throughExperienceRpcCarrier(connection))
  await store.refresh()
  await store.reviewHistoryRanking(row, 'baseline', 'Observed baseline is better', 'usage-1')
  expect(calls.find(x => x.endpoint === 'learning/ranking-review')?.payload).toMatchObject({ input: {
    predictionId: 'prediction-1', preferredOrder: 'baseline',
    rankingDigest: digest({ projectionKey: learning.projectionKey, builderVersion: learning.builderVersion, ranking: row.prediction.ranking }),
    evidenceRefs: [{ kind: 'usage', id: 'usage-1', digest: null }],
  } })
  expect(store.getSnapshot().receipt?.receiptId).toBe('receipt-1')
  expect(calls.slice(-2).map(x => x.endpoint)).toEqual(['receipt/get', 'learning/governance'])
  rejectReceipt = true
  await store.reviewHistoryRanking(row, 'unknown', 'Cannot determine', 'usage-1')
  expect(store.getSnapshot().phase).toBe('error')
  expect(store.getSnapshot().error).toContain('readback failed')
})
