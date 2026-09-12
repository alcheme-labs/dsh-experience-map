import { ExperienceError } from '../errors.js'
import { brandedId } from '../ids.js'
import type { LocalOwnerPrincipalId } from '../ids.js'
import type { ActorView } from '../types.js'

/** Origin established by an in-process adapter, never by a command payload. */
export type TrustedCommandOrigin =
  | { readonly kind: 'authenticated-browser' }
  | { readonly kind: 'management-cli' }
  | {
    readonly kind: 'restricted-runtime'
    readonly runtimeKind: 'agent' | 'model' | 'system_policy' | 'automation'
    readonly runtimeId: string
  }

/** Map trusted transport facts to durable authority without accepting self-assertion. */
export class ActorResolver {
  /** Create a resolver for the database-owned local principal. */
  constructor(private readonly localOwnerPrincipalId: LocalOwnerPrincipalId) {}

  /** Resolve one adapter-owned origin to its distinct actor and authority. */
  resolve(origin: TrustedCommandOrigin): ActorView {
    if (origin.kind === 'authenticated-browser') {
      return {
        actorId: brandedId<'ExperienceActorId'>(`browser:${this.localOwnerPrincipalId}`, 'actorId'),
        principalId: this.localOwnerPrincipalId,
        kind: 'browser_local_owner',
        authority: 'owner',
      }
    }
    if (origin.kind === 'management-cli') {
      return {
        actorId: brandedId<'ExperienceActorId'>(`management:${this.localOwnerPrincipalId}`, 'actorId'),
        principalId: this.localOwnerPrincipalId,
        kind: 'management_local_owner',
        authority: 'owner',
      }
    }
    if (origin.runtimeId.trim() === '') {
      throw new ExperienceError('principal_unauthorized', 'restricted runtime origin requires a non-empty runtime id')
    }
    return {
      actorId: brandedId<'ExperienceActorId'>(`${origin.runtimeKind}:${origin.runtimeId}`, 'actorId'),
      principalId: this.localOwnerPrincipalId,
      kind: origin.runtimeKind,
      authority: 'query_only',
    }
  }

  /** Resolve direct `source.kind=user` input accepted by this local Harness profile. */
  resolveLocalUserTask(): ActorView {
    return {
      actorId: brandedId<'ExperienceActorId'>(`local-user-task:${this.localOwnerPrincipalId}`, 'actorId'),
      principalId: this.localOwnerPrincipalId,
      kind: 'local_user_task',
      authority: 'owner',
    }
  }
}
