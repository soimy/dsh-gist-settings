#!/usr/bin/env node
/**
 * Child-process helper for the cross-process state-lock test in `safety.test.mjs`.
 *
 * It takes the lock, records entry and exit around a delay, and exits. Two of
 * these run at once: if the lock is doing its job the two critical sections are
 * serialised, and if it is not, the log interleaves.
 *
 * Usage: node lock-worker.mjs <logPath> <tag> <holdMs> <dshHome>
 */

import fs from 'node:fs/promises'

import * as core from '../lib/core.js'

const [logPath, tag, holdMs, dshHome] = process.argv.slice(2)

await core.withStateLock(async () => {
  await fs.appendFile(logPath, `${tag}:in\n`, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
  await fs.appendFile(logPath, `${tag}:out\n`, 'utf8')
}, { dshHome })