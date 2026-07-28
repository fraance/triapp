/**
 * Loads environment variables for the test suites.
 *
 * This MUST be the first import in every test file: `import` statements are
 * hoisted and executed before any other code in the module body, so calling
 * dotenv inline would run too late — the database client is configured at
 * import time.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });
