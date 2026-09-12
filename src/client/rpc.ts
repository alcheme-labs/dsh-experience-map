import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { EXPERIENCE_RPC_CHANNEL, EXPERIENCE_RPC_ENDPOINT } from '../rpc-channel.js'

/** Carry one logical Experience endpoint through the authenticated shared API route. */
export function callExperienceRpc(
  connection: ConnectionHandle,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ConnectionRpcResult<unknown>> {
  return connection.rpc.call(
    EXPERIENCE_RPC_CHANNEL,
    EXPERIENCE_RPC_ENDPOINT,
    { endpoint, payload },
    signal,
  )
}

/** Preserve the existing store call surface while routing every call through one exact carrier. */
export function experienceRpcConnection(connection: ConnectionHandle): ConnectionHandle {
  return {
    rpc: {
      call: (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) =>
        callExperienceRpc(connection, endpoint, payload, signal),
    },
  } as unknown as ConnectionHandle
}
