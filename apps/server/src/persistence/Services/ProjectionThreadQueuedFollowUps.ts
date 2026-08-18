/**
 * ProjectionThreadQueuedFollowUpRepository - Projection repository for the
 * per-thread follow-up queue.
 *
 * Queued follow-ups are thread state, not composer state: they survive reload,
 * reconnect, and server restart because they live here.
 *
 * @module ProjectionThreadQueuedFollowUpRepository
 */
import {
  ChatAttachment,
  IsoDateTime,
  ModelSelection,
  OrchestrationQueuedFollowUpStatus,
  ProviderInteractionMode,
  QueuedFollowUpId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedFollowUp = Schema.Struct({
  followUpId: QueuedFollowUpId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  orderKey: TrimmedNonEmptyString,
  status: OrchestrationQueuedFollowUpStatus,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadQueuedFollowUp = typeof ProjectionThreadQueuedFollowUp.Type;

export const GetProjectionThreadQueuedFollowUpInput = Schema.Struct({
  followUpId: QueuedFollowUpId,
});
export type GetProjectionThreadQueuedFollowUpInput =
  typeof GetProjectionThreadQueuedFollowUpInput.Type;

export const ListProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadQueuedFollowUpsInput =
  typeof ListProjectionThreadQueuedFollowUpsInput.Type;

export const DeleteProjectionThreadQueuedFollowUpInput = Schema.Struct({
  followUpId: QueuedFollowUpId,
});
export type DeleteProjectionThreadQueuedFollowUpInput =
  typeof DeleteProjectionThreadQueuedFollowUpInput.Type;

export const DeleteProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadQueuedFollowUpsInput =
  typeof DeleteProjectionThreadQueuedFollowUpsInput.Type;

export const SetProjectionThreadQueuedFollowUpStatusInput = Schema.Struct({
  threadId: ThreadId,
  fromStatus: OrchestrationQueuedFollowUpStatus,
  toStatus: OrchestrationQueuedFollowUpStatus,
  updatedAt: IsoDateTime,
});
export type SetProjectionThreadQueuedFollowUpStatusInput =
  typeof SetProjectionThreadQueuedFollowUpStatusInput.Type;

export interface ProjectionThreadQueuedFollowUpRepositoryShape {
  readonly upsert: (
    followUp: ProjectionThreadQueuedFollowUp,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadQueuedFollowUpInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  /** Queue order: `orderKey` ascending, id tiebreak. */
  readonly listByThreadId: (
    input: ListProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionThreadQueuedFollowUpInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Bulk status transition for one thread — how a stop pauses the queue and how
   * a dispatch resumes it, both derived from events that already exist.
   */
  readonly setStatusByThreadId: (
    input: SetProjectionThreadQueuedFollowUpStatusInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedFollowUpRepository extends Context.Service<
  ProjectionThreadQueuedFollowUpRepository,
  ProjectionThreadQueuedFollowUpRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadQueuedFollowUps/ProjectionThreadQueuedFollowUpRepository",
) {}
