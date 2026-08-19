import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Retires the thread settle/unsettle lifecycle (added by migration 033): the
// read model no longer carries an override, so the columns are dead weight.
// The retired "thread.settled"/"thread.unsettled" history events stay
// decodable and are simply ignored by both projectors.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN settled_override
    `;
  }

  if (columns.some((column) => column.name === "settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN settled_at
    `;
  }
});
