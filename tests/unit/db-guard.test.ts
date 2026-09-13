import { test } from "node:test";
import { strict as assert } from "node:assert";

import { assertSafeTestDatabaseTarget } from "@tests/helpers/db";

test("resetDatabase guard accepts explicit matching _test database only", () => {
  const target = assertSafeTestDatabaseTarget({
    databaseUrl: "postgresql://user:secret@localhost:5432/jully_dev_test",
    actualDatabase: "jully_dev_test",
  });

  assert.equal(target, "jully_dev_test");
});

test("resetDatabase guard rejects jully_dev even when NODE_ENV is test", () => {
  assert.throws(
    () =>
      assertSafeTestDatabaseTarget({
        databaseUrl: "postgresql://user:secret@localhost:5432/jully_dev",
        actualDatabase: "jully_dev",
      }),
    /resetDatabase recusado/
  );
});

test("resetDatabase guard rejects URL/actual database mismatch", () => {
  assert.throws(
    () =>
      assertSafeTestDatabaseTarget({
        databaseUrl: "postgresql://user:secret@localhost:5432/jully_dev_test",
        actualDatabase: "postgres",
      }),
    /resetDatabase recusado/
  );
});
