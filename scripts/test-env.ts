/* Where the test suite's own server lives.

   The tests used to run against the same port and the same data file as the
   real service, so `npm test` would move the live database aside on every run
   and replace it with throwaway accounts. Every account on the server then
   looked deleted, the phone's stored token came back 401, and the app dropped
   the user back to the welcome screen. The test server gets its own port and
   its own disposable data file so the two can never meet.

   Keep TEST_PORT in step with scripts/serve.sh, which starts that server. */
import { join } from "node:path";

export const TEST_PORT = Number(process.env.SYNCURA_TEST_PORT ?? 5003);

export const TEST_BASE = process.env.BASE ?? `http://localhost:${TEST_PORT}`;

export const TEST_API = process.env.API ?? `http://localhost:${TEST_PORT}`;

/* Deliberately inside data/ but a different file from the live database, and
   never named syncura.json so nothing can mistake it for the real thing. */
export const TEST_DATA_FILE =
  process.env.SYNCURA_TEST_DATA_FILE ?? join(process.cwd(), "data", "syncura.test.json");
