import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';

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
  const { files, videoCodec, audioCodec, videoBitrate, audioChannels, deleteOriginal } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ ok: false, error: 'No files provided.' });
  }
  const results = [];
  for (const file of files) {
    const output = buildOutputPath(file);
    const args = buildFfmpegArgs(file, output, { videoCodec, audioCodec, videoBitrate, audioChannels });
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        lastFfmpegProcess = ff;
        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });
        ff.on('close', code => {
          lastFfmpegProcess = null;
          if (code === 0) resolve();
          else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
      });
      // Delete original file if requested and transcode succeeded
      if (deleteOriginal) {
        try {
          await fs.unlink(file);
        } catch (delErr) {
          results.push({ file, output, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}` });
          continue;
        }
      }
      results.push({ file, output, ok: true });
    } catch (err) {
      results.push({ file, output, ok: false, error: err.message });
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

export default { transcode, transcodeStream };
