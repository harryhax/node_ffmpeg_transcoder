import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';

const transcodeLocationRoot = path.resolve(process.env.TRANSCODE_LOCATION_ROOT || process.cwd());

function resolveTranscodeLocation(inputPath) {
  if (!inputPath) {
    return null;
  }

  const resolved = path.resolve(String(inputPath));
  const relativeToRoot = path.relative(transcodeLocationRoot, resolved);
  const isInsideRoot =
    relativeToRoot === '' ||
    (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));

  if (!isInsideRoot) {
    throw new Error(`transcodeLocation must be inside ${transcodeLocationRoot}`);
  }

  return resolved;
}

function buildOutputPath(inputPath) {
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const dir = path.dirname(inputPath);
  return path.join(dir, `${base}.transcoded${ext}`);
}

function buildFfmpegArgs(input, output, opts) {
  const args = ['-y', '-i', input];
  if (opts.videoCodec) args.push('-c:v', opts.videoCodec);
  if (opts.videoBitrate) args.push('-b:v', `${opts.videoBitrate}k`);
  if (opts.audioCodec) args.push('-c:a', opts.audioCodec);
  if (opts.audioChannels) args.push('-ac', opts.audioChannels);
  args.push(output);
  return args;
}

// Store last ffmpeg process for streaming
let lastFfmpegProcess = null;

const transcode = async (req, res) => {
  const { files, videoCodec, audioCodec, videoBitrate, audioChannels, deleteOriginal, transcodeLocation } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ ok: false, error: 'No files provided.' });
  }
  let safeTranscodeLocation = null;
  try {
    safeTranscodeLocation = resolveTranscodeLocation(transcodeLocation);
    if (safeTranscodeLocation) {
      await fs.mkdir(safeTranscodeLocation, { recursive: true });
    }
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  const results = [];
  for (const file of files) {
    let workingInput = file;
    let workingOutput;
    let tempInput = null;
    let tempOutput = null;
    try {
      // If transcodeLocation is set, copy file there and transcode in that folder
      if (safeTranscodeLocation) {
        const fileName = path.basename(file);
        tempInput = path.join(safeTranscodeLocation, fileName);
        await fs.copyFile(file, tempInput);
        workingInput = tempInput;
        tempOutput = buildOutputPath(tempInput);
        workingOutput = tempOutput;
      } else {
        workingOutput = buildOutputPath(file);
      }
      const args = buildFfmpegArgs(workingInput, workingOutput, { videoCodec, audioCodec, videoBitrate, audioChannels });
      console.log(`Running ffmpeg: ffmpeg ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`);
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        lastFfmpegProcess = ff;
        let stderr = '';
        ff.stderr.on('data', d => {
          const msg = d.toString();
          stderr += msg;
          process.stdout.write(msg);
        });
        ff.stdout && ff.stdout.on('data', d => process.stdout.write(d.toString()));
        ff.on('close', code => {
          lastFfmpegProcess = null;
          if (code === 0) resolve();
          else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
      });
      // If transcodeLocation, copy result back to original folder
      if (safeTranscodeLocation && tempOutput) {
        const origOutput = buildOutputPath(file);
        await fs.copyFile(tempOutput, origOutput);
        // Clean up temp files
        await fs.unlink(tempInput);
        await fs.unlink(tempOutput);
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: origOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}` });
            continue;
          }
        }
        results.push({ file, output: origOutput, ok: true });
      } else {
        // No transcodeLocation, just handle output in place
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: workingOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}` });
            continue;
          }
        }
        results.push({ file, output: workingOutput, ok: true });
      }
    } catch (err) {
      results.push({ file, output: workingOutput, ok: false, error: err.message });
      // Clean up temp files if error
      if (tempInput) { try { await fs.unlink(tempInput); } catch {} }
      if (tempOutput) { try { await fs.unlink(tempOutput); } catch {} }
    }
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    return res.status(500).json({ ok: false, error: `Some files failed: ${failed.map(f => f.file).join(', ')}` });
  }
  res.json({ ok: true, message: `Transcoded ${results.length} file(s).`, results });
};

// SSE endpoint for streaming ffmpeg output
const transcodeStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!lastFfmpegProcess) {
    res.write('event: done\ndata: No transcode in progress.\n\n');
    res.end();
    return;
  }
  const onData = (data) => {
    res.write(`data: ${data.toString().replace(/\n/g, '\ndata: ')}\n\n`);
  };
  lastFfmpegProcess.stderr.on('data', onData);
  lastFfmpegProcess.on('close', () => {
    res.write('event: done\ndata: Transcode finished.\n\n');
    res.end();
  });
  req.on('close', () => {
    if (lastFfmpegProcess && lastFfmpegProcess.stderr) {
      lastFfmpegProcess.stderr.off('data', onData);
    }
  });
};

// Cancel endpoint: kill ffmpeg process
export const transcodeCancel = (req, res) => {
  if (lastFfmpegProcess && lastFfmpegProcess.kill) {
    lastFfmpegProcess.kill('SIGTERM');
    console.log('Transcode cancelled by user.');
    return res.json({ ok: true, message: 'Transcode cancelled.' });
  }
  res.status(400).json({ ok: false, error: 'No transcode in progress.' });
};

export default { transcode, transcodeStream, transcodeCancel };
