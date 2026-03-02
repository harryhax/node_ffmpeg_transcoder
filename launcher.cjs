#!/usr/bin/env node

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appRoot = path.join(path.dirname(process.execPath), 'app');
const entryUrl = pathToFileURL(path.join(appRoot, 'index.js')).href;

import(entryUrl).catch((error) => {
  console.error(error);
  process.exit(1);
});
