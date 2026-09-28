#!/usr/bin/env node
/**
 * Deliver a response body before exiting, or fail loudly trying.
 *
 * `process.exit()` does not wait for a write to a pipe, and the fake `gh` answers
 * `GET /gists/<id>` and a raw URL with the whole payload — hundreds of kilobytes for
 * the suites that track a few hundred files, and 1.5 MB for the live truncation
 * case, both past the pipe buffer. Exiting with the body still queued delivered half
 * of it, which core reported as `gh returned non-JSON output` and which read like a
 * defect in the plugin.
 *
 * This lives in its own module so the give-up branch can be tested directly. Staging
 * a flush that genuinely never completes is not portable: on POSIX the writer queues
 * the rest of the body and carries on, while on Windows a full pipe blocks the
 * writing thread, so the process never reaches its own timeout and a test can only
 * hang. (`write`, `exit` and `stderr` are injectable for that test — the double
 * passes none of them and gets the process's own.)
 */

import fs from 'node:fs'

/** Never let the response sit undelivered forever. */
export const FLUSH_TIMEOUT_MS = 5_000

/** Written synchronously, because it has to survive the exit on the next line. */
const synchronousStderr = { write: (text) => fs.writeSync(2, text) }

export async function flushThenExit({
  code = 0,
  timeoutMs = FLUSH_TIMEOUT_MS,
  write = process.stdout,
  stderr = synchronousStderr,
  exit = process.exit,
} = {}) {
  const flushed = await new Promise((resolve) => {
    // Deliberately not unref'd: a flush that never finishes has to reach this
    // timeout and fail, not drain the event loop and exit 0.
    const timer = setTimeout(() => resolve(false), timeoutMs)
    write.write('', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

  if (!flushed) {
    // Handing back a half-written body as a *successful* response is the exact
    // failure this function exists to prevent, so it fails loudly instead. The caller
    // then reports the CLI as failing rather than as answering with something
    // unparseable, which is both truer and easier to act on.
    stderr.write(`fake gh: stdout did not drain within ${timeoutMs}ms; the response was not delivered\n`)
    exit(1)
    return
  }
  exit(code)
}