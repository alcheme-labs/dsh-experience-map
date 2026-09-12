/** Shared authenticated Connection route used by the Experience Browser carrier. */
export const EXPERIENCE_RPC_CHANNEL = '/api'
/** One exact endpoint avoids competing with the Typert Gateway endpoint owner. */
export const EXPERIENCE_RPC_ENDPOINT = 'experience-map'
/** Host Fetch registration corresponding to the standard Connection RPC call. */
export const EXPERIENCE_RPC_PATH = `${EXPERIENCE_RPC_CHANNEL}/${EXPERIENCE_RPC_ENDPOINT}`
