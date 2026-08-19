import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0042 from "./042_ProjectionThreadsDropSettled.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadsDropSettled", (it) => {
  it.effect("drops the retired settlement columns from thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(before.some((column) => column.name === "settled_override"));
      assert.isTrue(before.some((column) => column.name === "settled_at"));

      yield* runMigrations({ toMigrationInclusive: 42 });
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(after.some((column) => column.name === "settled_override"));
      assert.isFalse(after.some((column) => column.name === "settled_at"));
      // The rest of the row must survive the rewrite ALTER TABLE performs.
      assert.isTrue(after.some((column) => column.name === "snoozed_until"));
      assert.isTrue(after.some((column) => column.name === "pinned_at"));

      // Replaying it against a database that no longer has the columns must be
      // a no-op instead of a hard failure.
      yield* Migration0042;
      const replayed = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepEqual(
        replayed.map((column) => column.name),
        after.map((column) => column.name),
      );
    }),
  );
});
