import { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadQueuedFollowUpInput,
  DeleteProjectionThreadQueuedFollowUpsInput,
  GetProjectionThreadQueuedFollowUpInput,
  ListProjectionThreadQueuedFollowUpsInput,
  ProjectionThreadQueuedFollowUp,
  ProjectionThreadQueuedFollowUpRepository,
  type ProjectionThreadQueuedFollowUpRepositoryShape,
  SetProjectionThreadQueuedFollowUpStatusInput,
} from "../Services/ProjectionThreadQueuedFollowUps.ts";

const ProjectionThreadQueuedFollowUpDbRowSchema = ProjectionThreadQueuedFollowUp.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);

const makeProjectionThreadQueuedFollowUpRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadQueuedFollowUp,
    execute: (row) => sql`
      INSERT INTO projection_thread_queued_follow_ups (
        follow_up_id,
        thread_id,
        text,
        attachments_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        order_key,
        status,
        last_error,
        created_at,
        updated_at
      )
      VALUES (
        ${row.followUpId},
        ${row.threadId},
        ${row.text},
        ${JSON.stringify(row.attachments)},
        ${row.modelSelection === null ? null : JSON.stringify(row.modelSelection)},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.orderKey},
        ${row.status},
        ${row.lastError},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (follow_up_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        text = excluded.text,
        attachments_json = excluded.attachments_json,
        model_selection_json = excluded.model_selection_json,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        order_key = excluded.order_key,
        status = excluded.status,
        last_error = excluded.last_error,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedFollowUpInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ followUpId }) => sql`
      SELECT
        follow_up_id AS "followUpId",
        thread_id AS "threadId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        order_key AS "orderKey",
        status,
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_queued_follow_ups
      WHERE follow_up_id = ${followUpId}
      LIMIT 1
    `,
  });

  const listRowsByThreadId = SqlSchema.findAll({
    Request: ListProjectionThreadQueuedFollowUpsInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        follow_up_id AS "followUpId",
        thread_id AS "threadId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        order_key AS "orderKey",
        status,
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_queued_follow_ups
      WHERE thread_id = ${threadId}
      ORDER BY order_key ASC, follow_up_id ASC
    `,
  });

  const deleteRowById = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedFollowUpInput,
    execute: ({ followUpId }) => sql`
      DELETE FROM projection_thread_queued_follow_ups
      WHERE follow_up_id = ${followUpId}
    `,
  });

  const deleteRowsByThreadId = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedFollowUpsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_queued_follow_ups
      WHERE thread_id = ${threadId}
    `,
  });

  const setRowStatusByThreadId = SqlSchema.void({
    Request: SetProjectionThreadQueuedFollowUpStatusInput,
    execute: ({ threadId, fromStatus, toStatus, updatedAt }) => sql`
      UPDATE projection_thread_queued_follow_ups
      SET status = ${toStatus}, updated_at = ${updatedAt}
      WHERE thread_id = ${threadId} AND status = ${fromStatus}
    `,
  });

  const upsert: ProjectionThreadQueuedFollowUpRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.upsert:query"),
      ),
    );

  const getById: ProjectionThreadQueuedFollowUpRepositoryShape["getById"] = (input) =>
    getRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.getById:query"),
      ),
    );

  const listByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["listByThreadId"] = (input) =>
    listRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.listByThreadId:query"),
      ),
    );

  const deleteById: ProjectionThreadQueuedFollowUpRepositoryShape["deleteById"] = (input) =>
    deleteRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteById:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteByThreadId:query"),
      ),
    );

  const setStatusByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["setStatusByThreadId"] =
    (input) =>
      setRowStatusByThreadId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadQueuedFollowUpRepository.setStatusByThreadId:query",
          ),
        ),
      );

  return {
    upsert,
    getById,
    listByThreadId,
    deleteById,
    deleteByThreadId,
    setStatusByThreadId,
  } satisfies ProjectionThreadQueuedFollowUpRepositoryShape;
});

export const ProjectionThreadQueuedFollowUpRepositoryLive = Layer.effect(
  ProjectionThreadQueuedFollowUpRepository,
  makeProjectionThreadQueuedFollowUpRepository,
);
