#!/usr/bin/env node

const oclif = require('@oclif/core');

oclif
  .run(process.argv.slice(2), __dirname)
  .then(require('@oclif/core/flush'))
  .catch(require('@oclif/core/handle'));
