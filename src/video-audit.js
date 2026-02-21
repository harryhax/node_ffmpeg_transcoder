#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  collectVideoFiles,
  inspectWithFallback,
  formatBps,
  formatSize,
  normalizeBitrateToBps
} from './audit-core.js';

function parseArgs(argv) {
  const args = {
    root: '.',
    pageSize: 10,
    videoCodec: undefined,
    videoBitrate: undefined,
    videoBitrateOp: '>=',
    audioCodec: undefined,
    audioChannels: undefined,
    audioChannelsOp: '>='
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--root' && next) {
      args.root = next;
      i += 1;
    } else if (token === '--page-size' && next) {
      args.pageSize = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--video-codec' && next) {
      args.videoCodec = next.toLowerCase();
      i += 1;
    } else if (token === '--video-bitrate' && next) {
      args.videoBitrate = normalizeBitrateToBps(next);
      i += 1;
    } else if (token === '--video-bitrate-op' && next) {
      args.videoBitrateOp = next;
      i += 1;
    } else if (token === '--audio-codec' && next) {
      args.audioCodec = next.toLowerCase();
      i += 1;
    } else if (token === '--audio-channels' && next) {
      args.audioChannels = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--audio-channels-op' && next) {
      args.audioChannelsOp = next;
      i += 1;
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  const validOperators = new Set(['>=', '<=', '=']);
  if (!validOperators.has(args.videoBitrateOp)) {
    throw new Error('--video-bitrate-op must be one of: >=, <=, =');
  }
  if (!validOperators.has(args.audioChannelsOp)) {
    throw new Error('--audio-channels-op must be one of: >=, <=, =');
  }

  if (!Number.isFinite(args.pageSize) || args.pageSize < 1) {
    throw new Error('--page-size must be a positive integer.');
  }

  if (args.audioChannels !== undefined && (!Number.isFinite(args.audioChannels) || args.audioChannels < 1)) {
    throw new Error('--audio-channels must be a positive integer.');
  }

  return args;
}

function printHelp() {
  console.log(`Video Encoding Auditor\n\nUsage:\n  node src/video-audit.js [options]\n\nOptions:\n  --root <path>                Root folder to scan recursively (default: .)\n  --video-codec <codec>        Expected video codec (e.g. hevc, h264)\n  --video-bitrate <value>      Expected video bitrate (e.g. 6000k, 6M, 4500000)\n  --video-bitrate-op <op>      Bitrate rule operator: >=, <=, = (default: >=)\n  --audio-codec <codec>        Expected audio codec (e.g. ac3, aac)\n  --audio-channels <num>       Expected channel count (e.g. 6 for 5.1)\n  --audio-channels-op <op>     Channel rule operator: >=, <=, = (default: >=)\n  --page-size <num>            Results per page (default: 10)\n  -h, --help                   Show this help\n\nExamples:\n  node src/video-audit.js --root ./videos --video-codec h264 --video-bitrate 6000k --video-bitrate-op '>=' --audio-codec ac3 --audio-channels 6 --audio-channels-op '>='\n`);
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

async function promptNextAction(reader, shown, total, pageSize) {
  let answer = '';
  try {
    answer = await reader.question(`\nShowing ${shown}/${total}. Press Enter or 'n' for next ${pageSize}, 'q' to quit: `);
  } catch {
    return 'quit';
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'q' || normalized === 'quit') {
    return 'quit';
  }
  return 'next';
}

function printPageTable(startIndex, results, rootPath) {
  const rows = results.map((result, offset) => {
    const rel = path.relative(rootPath, result.file.path) || path.basename(result.file.path);
    return {
      '#': startIndex + offset + 1,
      status: result.matches ? 'MATCH' : 'MISMATCH',
      size: formatSize(result.file.size),
      vCodec: result.actual.videoCodec || 'unknown',
      vBitrate: formatBps(result.actual.videoBitrate),
      aCodec: result.actual.audioCodec || 'unknown',
      aCh: result.actual.audioChannels || 'unknown',
      issues: result.mismatches.length,
      file: truncateText(rel, 72)
    };
  });

  console.log('');
  console.table(rows);

  const mismatches = results
    .map((result, offset) => ({ index: startIndex + offset + 1, result }))
    .filter((item) => !item.result.matches);

  if (mismatches.length) {
    console.log('Mismatch details:');
    for (const item of mismatches) {
      const rel = path.relative(rootPath, item.result.file.path) || path.basename(item.result.file.path);
      console.log(`- #${item.index} ${rel}`);
      for (const reason of item.result.mismatches) {
        console.log(`  - ${reason}`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const rootPath = path.resolve(args.root);

  console.log(`Scanning videos under: ${rootPath}`);
  const files = await collectVideoFiles(rootPath);

  if (files.length === 0) {
    console.log('No video files found.');
    return;
  }

  console.log(`Found ${files.length} video file(s). Checking largest first...`);

  const reader = readline.createInterface({ input: stdin, output: stdout });
  let checkedCount = 0;
  let mismatchedCount = 0;
  let quitRequested = false;
  let pageResults = [];
  let pageStartIndex = 0;

  try {
    for (let i = 0; i < files.length; i += 1) {
      const result = await inspectWithFallback(files[i], args);

      pageResults.push(result);
      checkedCount += 1;
      if (!result.matches) {
        mismatchedCount += 1;
      }

      const pageBoundary = checkedCount % args.pageSize === 0;
      const endOfList = checkedCount === files.length;

      if (pageBoundary || endOfList) {
        printPageTable(pageStartIndex, pageResults, rootPath);
        pageStartIndex = checkedCount;
        pageResults = [];

        const hasMore = checkedCount < files.length;
        if (hasMore) {
          const action = await promptNextAction(reader, checkedCount, files.length, args.pageSize);
          if (action === 'quit') {
            quitRequested = true;
            break;
          }
        }
      }
    }
  } finally {
    reader.close();
  }

  const suffix = quitRequested ? ' (quit early)' : '';
  console.log(`\nDone${suffix}. Checked ${checkedCount}/${files.length} file(s). Mismatches: ${mismatchedCount}.`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
