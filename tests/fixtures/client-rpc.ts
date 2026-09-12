import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'

interface ExperienceRpcCarrier {
  readonly endpoint: string
  readonly payload: unknown
}

/**
 * Adapt an existing logical-endpoint test double to the real authenticated
 * Connection carrier used by Browser clients.
 */
export function throughExperienceRpcCarrier(logical: ConnectionHandle): ConnectionHandle {
  return {
    rpc: {
      call: (
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<ConnectionRpcResult<unknown>> => {
        if (channel !== '/api' || endpoint !== 'experience-map') {
          throw new Error(`unexpected Experience RPC carrier ${channel}/${endpoint}`)
        }
        if (!isCarrier(payload)) throw new Error('invalid Experience RPC carrier payload')
        return logical.rpc.call('/experience-map', payload.endpoint, payload.payload, signal)
      },
    },
  } as unknown as ConnectionHandle
}

function isCarrier(value: unknown): value is ExperienceRpcCarrier {
  return typeof value === 'object'
    && value !== null
    && Object.keys(value).length === 2
    && typeof (value as { readonly endpoint?: unknown }).endpoint === 'string'
    && 'payload' in value
}
