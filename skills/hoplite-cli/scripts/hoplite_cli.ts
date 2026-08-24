#!/usr/bin/env bun

import {
  run,
  safeErrorMessage,
} from '../../../packages/cli/src/index.ts';

run(process.argv.slice(2))
  .then(result => {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  })
  .catch(error => {
    console.error(JSON.stringify({ ok: false, error: safeErrorMessage(error) }, null, 2));
    process.exitCode = 1;
  });
