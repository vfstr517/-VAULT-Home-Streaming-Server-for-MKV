const express = require('express');
const { spawn, execFile } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const app  = express();
const PORT = 3000;

// ============================================================
//  CONFIGURE — point to your videos folder
// ============================================================
const VIDEOS_DIR = 'E:/Movies/videos';

// Seconds to wait for GPU selection before defaulting to CPU
const GPU_SELECT_TIMEOUT_S = 10;

// Supported video file extensions
const VIDEO_EXTS = /\.(mkv|mp4|m4v|mov|avi|wmv|ts|webm)$/i;

// ============================================================

const TEMP_DIR         = path.join(__dirname, 'temp');
const CACHE_LIMIT_FILE = path.join(__dirname, 'cache_limit.txt');
const activeJobs       = {};
const streamProgress   = {};

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(CACHE_LIMIT_FILE)) {
  fs.writeFileSync(CACHE_LIMIT_FILE, '20\n');
  console.log('[cache] Created cache_limit.txt (default 20 GB)');
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/hls', express.static(TEMP_DIR));

// ──────────────────────────────────────────────────────────
// GPU — scan device then prompt with only what works
//
// 1. Check ffmpeg -encoders for each candidate
// 2. Run a real test-encode to confirm the driver works
// 3. Present only verified options + CPU fallback
// 4. If nothing found, skip prompt and use CPU silently
// ──────────────────────────────────────────────────────────
let GPU = null;

const GPU_CANDIDATES = [
  { encoder: 'h264_nvenc', hwaccel: 'cuda',    label: 'NVIDIA NVENC' },
  { encoder: 'h264_amf',   hwaccel: 'd3d11va', label: 'AMD AMF'      },
  { encoder: 'h264_qsv',   hwaccel: 'qsv',     label: 'Intel QSV'    },
];

async function scanGpus() {
  const encoderList = await new Promise(resolve =>
    execFile('ffmpeg', ['-hide_banner', '-encoders'],
      (err, stdout) => resolve(err ? '' : stdout))
  );

  const found = [];
  for (const c of GPU_CANDIDATES) {
    if (!encoderList.includes(c.encoder)) continue;
    process.stdout.write(`  Checking ${c.label}... `);
    const ok = await new Promise(resolve =>
      execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
        '-c:v', c.encoder, '-f', 'null', '-'
      ], { timeout: 15000 }, err => resolve(!err))
    );
    console.log(ok ? '✓' : 'not available');
    if (ok) found.push(c);
  }
  return found;
}

async function promptGpu() {
  console.log('\n  Scanning for GPU encoders...');
  const available = await scanGpus();

  // Nothing found — skip prompt entirely
  if (available.length === 0) {
    console.log('  No GPU encoders found — using CPU (libx264)');
    return null;
  }

  const options = [
    { label: 'CPU  (libx264)', value: null },
    ...available.map(g => ({ label: g.label, value: g })),
  ];

  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Select encoder for transcoding:');
  options.forEach((o, i) => console.log(`    [${i}] ${o.label}`));

  return new Promise(resolve => {
    let remaining = GPU_SELECT_TIMEOUT_S;
    let settled   = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(countdown);
      rl.close();
      resolve(value);
    };

    // Live countdown on the same line
    const redraw = () =>
      process.stdout.write(`\r  > auto-selects CPU in ${remaining}s  `);

    redraw();
    const countdown = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        process.stdout.write('\r  > Timed out — using CPU          \n');
        done(null);
      } else {
        redraw();
      }
    }, 1000);

    rl.on('line', line => {
      process.stdout.write('\n');
      const idx = parseInt(line.trim(), 10);
      if (!isNaN(idx) && idx >= 0 && idx < options.length) {
        done(options[idx].value);
      } else {
        console.log('  Invalid — defaulting to CPU');
        done(null);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────
// ffprobe helper
// ──────────────────────────────────────────────────────────
function ffprobe(filePath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      ...extraArgs, filePath
    ], (err, stdout) => {
      if (err) return reject(new Error('ffprobe failed: ' + err.message));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('ffprobe parse error')); }
    });
  });
}

const TEXT_SUB_CODECS   = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
const isTextSub         = c => TEXT_SUB_CODECS.includes((c || '').toLowerCase());
const COPY_VIDEO_CODECS = ['h264', 'avc', 'avc1'];

const ffmpegPath = p => p.replace(/\\/g, '/');

// ──────────────────────────────────────────────────────────
// GET /api/videos
// ──────────────────────────────────────────────────────────
app.get('/api/videos', (req, res) => {
  try {
    const files = fs.readdirSync(VIDEOS_DIR)
      .filter(f => VIDEO_EXTS.test(f))
      .map(f => ({
        filename: f,
        displayName: f.replace(VIDEO_EXTS, '').trim(),
        size: getFileSizeMB(path.join(VIDEOS_DIR, f))
      }));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Cannot read VIDEOS_DIR: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/info/:filename
// ──────────────────────────────────────────────────────────
app.get('/api/info/:filename', async (req, res) => {
  const filename  = decodeURIComponent(req.params.filename);
  const videoPath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Not found' });
  try {
    const probe = await ffprobe(videoPath, ['-show_streams', '-show_format']);
    res.json({
      audio: probe.streams
        .filter(s => s.codec_type === 'audio')
        .map((s, i) => ({
          index: i, language: s.tags?.language || 'und',
          label: buildAudioLabel(s, i), codec: s.codec_name, channels: s.channels
        })),
      subtitles: probe.streams
        .filter(s => s.codec_type === 'subtitle' && isTextSub(s.codec_name))
        .map((s, i) => ({
          index: i, language: s.tags?.language || 'und', label: buildSubLabel(s, i)
        }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────────────────
// GET /api/stream/:filename?audio=INDEX
// ──────────────────────────────────────────────────────────
app.get('/api/stream/:filename', async (req, res) => {
  const filename  = decodeURIComponent(req.params.filename);
  const videoPath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });

  const audioIdx = Math.max(0, parseInt(req.query.audio || '0', 10));
  const streamId = safeId(`${filename}::a${audioIdx}`);
  const streamDir = path.join(TEMP_DIR, streamId);
  const masterPath = path.join(streamDir, 'master.m3u8');

  // Cache hit
  if (fs.existsSync(masterPath)) {
    touchStream(streamDir);
    const p = streamProgress[streamId];
    console.log(`[cache hit] ${filename} audio=${audioIdx} (${p ? p.percent + '%' : 'done'})`);
    return res.json({ streamUrl: `/hls/${streamId}/master.m3u8`, streamId, cached: true });
  }

  if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });

  try {
    const probe     = await ffprobe(videoPath, ['-show_streams', '-show_format']);
    const allAudio  = probe.streams.filter(s => s.codec_type === 'audio');
    const subTracks = probe.streams.filter(s => s.codec_type === 'subtitle' && isTextSub(s.codec_name));
    const duration  = parseFloat(probe.format?.duration || 0);
    const strategy  = getStrategy(probe);
    const safeAudioIdx = Math.min(audioIdx, Math.max(0, allAudio.length - 1));
    const hasAudio  = allAudio.length > 0;

    console.log(`\n[stream] ${filename}`);
    console.log(`  Video:     ${strategy.videoCodec} (${strategy.copyVideo ? '⚡ copy' : GPU ? `🎮 ${GPU.label}` : '🔄 CPU libx264'})`);
    console.log(`  Audio:     track ${safeAudioIdx}/${allAudio.length - 1} — ${allAudio[safeAudioIdx] ? buildAudioLabel(allAudio[safeAudioIdx], safeAudioIdx) : 'none'}`);
    console.log(`  Subtitles: ${subTracks.length} text track(s)`);
    console.log(`  Duration:  ${fmtTime(duration)}`);

    // ── Step 1: Extract subtitle VTT content synchronously ──
    // We extract now so content is ready, but we don't write the
    // m3u8 yet — we need the first segment's actual PTS first.
    await extractSubtitleVtts(videoPath, streamDir, subTracks);

    // ── Step 2: Transcode video; resolves when seg00000.ts exists ──
    await runTranscode({ videoPath, streamDir, streamId, hasAudio, audioIdx: safeAudioIdx, strategy });

    // ── Step 3: Read actual MPEG-TS PTS from first segment ──
    // This is the only reliable way to get the right X-TIMESTAMP-MAP
    // value — don't guess or hardcode, read it from the real file.
    const firstSegPts = await getFirstSegPts(path.join(streamDir, 'seg00000.ts'));
    console.log(`[subtitle] First segment PTS: ${firstSegPts} ticks (${(firstSegPts / 90000).toFixed(3)}s)`);

    // ── Step 4: Finalise subtitles with correct timestamp anchor ──
    finalizeSubtitles(streamDir, subTracks, firstSegPts);

    // ── Step 5: Master playlist + respond ──
    buildMasterPlaylist(streamDir, subTracks, probe);
    touchStream(streamDir);

    const expectedSegs = duration > 0 ? Math.ceil(duration / 4) : null;
    streamProgress[streamId] = { done: false, percent: 0 };
    trackTranscodeProgress(streamId, streamDir, expectedSegs);

    enforceCacheLimit();
    res.json({ streamUrl: `/hls/${streamId}/master.m3u8`, streamId });

  } catch (err) {
    console.error('\n[error]', err.message);
    if (!activeJobs[streamId]) {
      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/progress/:streamId
// ──────────────────────────────────────────────────────────
app.get('/api/progress/:streamId', (req, res) => {
  const p = streamProgress[req.params.streamId];
  if (!p) return res.json({ found: false });
  res.json({ found: true, percent: p.percent || 0, done: p.done, error: p.error || null });
});

// ──────────────────────────────────────────────────────────
// Single-pass transcode
//
// GPU path (when source is NOT h264):
//   NVIDIA  -hwaccel cuda -hwaccel_output_format cuda → h264_nvenc
//   AMD     -hwaccel d3d11va                          → h264_amf
//   Intel   -hwaccel qsv                              → h264_qsv
//
// CPU fallback: libx264 -preset ultrafast
// h264 source: always stream-copied regardless of GPU
// ──────────────────────────────────────────────────────────
function runTranscode({ videoPath, streamDir, streamId, hasAudio, audioIdx, strategy }) {
  return new Promise((resolve, reject) => {
    const args = ['-y'];

    // Hardware decode (only meaningful when transcoding)
    if (!strategy.copyVideo && GPU) {
      args.push('-hwaccel', GPU.hwaccel);
      if (GPU.hwaccel === 'cuda') args.push('-hwaccel_output_format', 'cuda');
    }

    args.push('-i', ffmpegPath(videoPath));
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', `0:a:${audioIdx}`);

    // Video encode
    if (strategy.copyVideo) {
      args.push('-c:v', 'copy');
    } else if (GPU) {
      if (GPU.encoder === 'h264_nvenc') {
        args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23');
      } else if (GPU.encoder === 'h264_amf') {
        args.push('-c:v', 'h264_amf', '-quality', 'balanced', '-qp_i', '23', '-qp_p', '23');
      } else if (GPU.encoder === 'h264_qsv') {
        args.push('-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23');
      }
    } else {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23');
    }

    // Audio encode
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    else          args.push('-an');

    args.push(
      '-avoid_negative_ts', 'make_zero',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-hls_segment_filename', ffmpegPath(path.join(streamDir, 'seg%05d.ts')),
      '-f', 'hls', ffmpegPath(path.join(streamDir, 'video.m3u8'))
    );

    console.log(`\n[transcode] audio=a:${audioIdx}  video=${strategy.copyVideo ? 'copy' : (GPU ? GPU.encoder : 'libx264')}`);

    const proc = spawn('ffmpeg', args);
    activeJobs[streamId] = proc;

    let resolved  = false;
    let stderrBuf = '';
    const dotTimer = setInterval(() => process.stdout.write('.'), 5000);

    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('error', err => {
      clearInterval(dotTimer);
      delete activeJobs[streamId];
      reject(new Error('FFmpeg could not start: ' + err.message));
    });

    proc.on('close', code => {
      clearInterval(dotTimer);
      delete activeJobs[streamId];
      if (streamProgress[streamId]) streamProgress[streamId].done = true;
      if (code !== 0 && code !== null) {
        console.warn(`\n[ffmpeg] exit ${code}`);
        console.warn(stderrBuf.trim().split('\n').slice(-20).join('\n'));
      } else {
        console.log(`\n[✓ complete] Transcode finished`);
      }
      if (!resolved) {
        console.error('\n[ffmpeg stderr]\n' + stderrBuf.trim().split('\n').slice(-30).join('\n'));
        reject(new Error(`FFmpeg exited (${code}) before producing any segments`));
      }
    });

    // Resolve as soon as first segment is on disk
    const firstSeg = path.join(streamDir, 'seg00000.ts');
    const check = setInterval(() => {
      if (!resolved && fs.existsSync(firstSeg)) {
        resolved = true;
        clearInterval(check);
        clearTimeout(timeoutId);
        console.log('\n[ready] First segment ready');
        resolve();
      }
    }, 500);

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        clearInterval(check);
        clearInterval(dotTimer);
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
        reject(new Error(
          'No segment in 3 minutes. Test with:\n' +
          `ffmpeg -i "${videoPath}" -t 30 -c:v copy -c:a aac test.ts`
        ));
      }
    }, 3 * 60 * 1000);
  });
}

// ──────────────────────────────────────────────────────────
// Progress tracking
// ──────────────────────────────────────────────────────────
function trackTranscodeProgress(streamId, streamDir, expectedSegs) {
  const timer = setInterval(() => {
    const p = streamProgress[streamId];
    if (!p) { clearInterval(timer); return; }
    if (p.done) { p.percent = 100; clearInterval(timer); return; }
    if (expectedSegs) {
      p.percent = Math.min(99, Math.round((countTsFiles(streamDir) / expectedSegs) * 100));
    }
  }, 4000);
}

// ──────────────────────────────────────────────────────────
// Subtitle extraction — Step 1
//
// Extract VTT content only. No m3u8 written yet because we
// don't have the first segment's PTS yet (needed for the
// X-TIMESTAMP-MAP header).  Runs all tracks in parallel.
// ──────────────────────────────────────────────────────────
function extractSubtitleVtts(videoPath, streamDir, subTracks) {
  return Promise.all(subTracks.map((track, i) => new Promise(resolve => {
    const vttPath = path.join(streamDir, `sub_${i}.vtt`);
    // Already extracted on a previous cache hit
    if (fs.existsSync(vttPath)) { resolve(); return; }

    const proc = spawn('ffmpeg', [
      '-i', videoPath, '-map', `0:s:${i}`, '-c:s', 'webvtt', '-y', vttPath
    ]);
    proc.on('close', code => {
      if (code !== 0) console.warn(`[subtitle] Track ${i} extract failed (exit ${code})`);
      resolve();
    });
    proc.on('error', err => {
      console.warn(`[subtitle] Track ${i} spawn error: ${err.message}`);
      resolve();
    });
  })));
}

// ──────────────────────────────────────────────────────────
// Read first video segment's actual MPEG-TS PTS — Step 3
//
// We cannot assume the PTS value. FFmpeg's MPEG-TS muxer may
// start at 0, 90000, or any other value depending on the
// source container. Reading it directly is the only reliable
// approach — any hardcoded guess (0, 900000, etc.) will be
// wrong for some files and cause subtitle drift.
// ──────────────────────────────────────────────────────────
function getFirstSegPts(tsPath) {
  return new Promise(resolve => {
    execFile('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_entries', 'packet=pts',
      '-select_streams', 'v:0',
      '-read_intervals', '%+#1',   // only the very first packet
      tsPath
    ], (err, stdout) => {
      if (err) { resolve(0); return; }
      try {
        const pts = parseInt(JSON.parse(stdout).packets?.[0]?.pts ?? '0', 10);
        resolve(isNaN(pts) ? 0 : pts);
      } catch { resolve(0); }
    });
  });
}

// ──────────────────────────────────────────────────────────
// Finalise subtitles — Step 4
//
// Now that we have the real first-segment PTS we can write
// X-TIMESTAMP-MAP=MPEGTS:{pts},LOCAL:00:00:00.000
//
// This tells HLS.js: "TS PTS {pts} = VTT cue time 0:00:00.000"
// Because the VTT timestamps come from the original MKV (no
// normalisation applied during extraction), VTT 0:00:00 is
// the natural start of the file — identical to what the MPEG-TS
// PTS {pts} represents after -avoid_negative_ts make_zero.
// ──────────────────────────────────────────────────────────
function finalizeSubtitles(streamDir, subTracks, firstSegPts) {
  subTracks.forEach((track, i) => {
    const vttPath  = path.join(streamDir, `sub_${i}.vtt`);
    const m3u8Path = path.join(streamDir, `sub_${i}.m3u8`);
    if (fs.existsSync(m3u8Path)) return; // already done (cache)
    if (!fs.existsSync(vttPath)) return;  // extraction failed

    // Inject X-TIMESTAMP-MAP with actual measured PTS
    try {
      let content = fs.readFileSync(vttPath, 'utf8');
      if (!content.includes('X-TIMESTAMP-MAP')) {
        content = content.replace(
          /^(WEBVTT[^\r\n]*)(\r?\n)/,
          `$1$2X-TIMESTAMP-MAP=MPEGTS:${firstSegPts},LOCAL:00:00:00.000$2`
        );
        fs.writeFileSync(vttPath, content);
      }
    } catch (e) {
      console.warn(`[subtitle] X-TIMESTAMP-MAP inject failed for track ${i}:`, e.message);
    }

    // Write the HLS subtitle playlist now that the VTT is finalised
    fs.writeFileSync(m3u8Path,
      '#EXTM3U\n#EXT-X-TARGETDURATION:99999\n#EXT-X-VERSION:3\n#EXTINF:99999,\n' +
      `sub_${i}.vtt\n#EXT-X-ENDLIST\n`
    );
    console.log(`[subtitle] Track ${i} (${track.tags?.language || 'und'}) ready — MPEGTS:${firstSegPts}`);
  });
}

// ──────────────────────────────────────────────────────────
// Master playlist
// ──────────────────────────────────────────────────────────
function buildMasterPlaylist(streamDir, subTracks, probe) {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
  if (subTracks.length > 0) {
    subTracks.forEach((s, i) => {
      m += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${escM3U8(buildSubLabel(s, i))}",DEFAULT=NO,FORCED=NO,LANGUAGE="${s.tags?.language || 'und'}",URI="sub_${i}.m3u8"\n`;
    });
    m += '\n';
  }
  const vs = probe.streams.find(s => s.codec_type === 'video') || {};
  const w  = vs.width || 1920, h = vs.height || 1080;
  const sA = subTracks.length > 0 ? ',SUBTITLES="subs"' : '';
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${estimateBandwidth(w, h)},RESOLUTION=${w}x${h},CODECS="avc1.42e01e,mp4a.40.2"${sA}\nvideo.m3u8\n`;
  fs.writeFileSync(path.join(streamDir, 'master.m3u8'), m);
}

// ──────────────────────────────────────────────────────────
// Strategy
// ──────────────────────────────────────────────────────────
function getStrategy(probe) {
  const vs         = probe.streams.find(s => s.codec_type === 'video') || {};
  const videoCodec = (vs.codec_name || '').toLowerCase();
  return { videoCodec, copyVideo: COPY_VIDEO_CODECS.includes(videoCodec) };
}

// ──────────────────────────────────────────────────────────
// Cache management
// ──────────────────────────────────────────────────────────
function readCacheLimitGB() {
  try {
    const val = parseFloat(fs.readFileSync(CACHE_LIMIT_FILE, 'utf8').trim());
    return (!isNaN(val) && val > 0) ? val : 20;
  } catch { return 20; }
}

function getCacheEntries() {
  return fs.readdirSync(TEMP_DIR).map(name => {
    const dir = path.join(TEMP_DIR, name);
    try {
      if (!fs.statSync(dir).isDirectory()) return null;
      const tp = path.join(dir, 'last_accessed');
      const lastAccessed = fs.existsSync(tp) ? fs.statSync(tp).mtime : fs.statSync(dir).mtime;
      return { name, dir, lastAccessed, bytes: getDirSize(dir) };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.lastAccessed - b.lastAccessed);
}

function getDirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir)) {
      const full = path.join(dir, e);
      try { const s = fs.statSync(full); total += s.isDirectory() ? getDirSize(full) : s.size; } catch {}
    }
  } catch {}
  return total;
}

function touchStream(streamDir) {
  try { fs.writeFileSync(path.join(streamDir, 'last_accessed'), new Date().toISOString()); } catch {}
}

function enforceCacheLimit() {
  const limitBytes = readCacheLimitGB() * 1e9;
  const entries    = getCacheEntries();
  let total        = entries.reduce((s, e) => s + e.bytes, 0);
  if (total <= limitBytes) {
    console.log(`\n[cache] ${(total / 1e9).toFixed(2)} GB / ${(limitBytes / 1e9).toFixed(0)} GB`);
    return;
  }
  console.log(`\n[cache] Over limit (${(total / 1e9).toFixed(2)} GB) — evicting oldest…`);
  for (const e of entries) {
    if (total <= limitBytes * 0.8) break;
    if (activeJobs[e.name]) continue;
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      total -= e.bytes;
      delete streamProgress[e.name];
      console.log(`[evict] ${e.name}`);
    } catch (err) { console.warn(`[evict fail] ${err.message}`); }
  }
}

app.get('/api/cache', (req, res) => {
  const limitGB = readCacheLimitGB();
  const entries = getCacheEntries();
  const total   = entries.reduce((s, e) => s + e.bytes, 0);
  res.json({ limitGB, usedGB: +(total / 1e9).toFixed(2), entries: entries.length });
});

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
function countTsFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length;
}

function buildAudioLabel(s, i) {
  if (s.tags?.title) return s.tags.title;
  const lang = s.tags?.language;
  const base = lang && lang !== 'und' ? langName(lang) : `Track ${i + 1}`;
  const ch   = s.channels;
  return base + (ch === 6 ? ' · 5.1' : ch === 8 ? ' · 7.1' : '');
}

function buildSubLabel(s, i) {
  if (s.tags?.title) return s.tags.title;
  const lang = s.tags?.language;
  return lang && lang !== 'und' ? langName(lang) : `Subtitle ${i + 1}`;
}

function langName(code) {
  const m = { eng:'English',jpn:'Japanese',fra:'French',fre:'French',ger:'German',deu:'German',
    spa:'Spanish',ita:'Italian',por:'Portuguese',rus:'Russian',zho:'Chinese',chi:'Chinese',
    kor:'Korean',ara:'Arabic',hin:'Hindi',tam:'Tamil',tel:'Telugu',mal:'Malayalam',
    tha:'Thai',vie:'Vietnamese',ind:'Indonesian',msa:'Malay',und:'Unknown' };
  return m[code?.toLowerCase()] || code?.toUpperCase() || 'Unknown';
}

function fmtTime(s) {
  if (s == null || isNaN(s)) return '?';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}h${String(m).padStart(2,'0')}m` : `${m}m${String(sec).padStart(2,'0')}s`;
}

function estimateBandwidth(w, h) {
  if (h >= 2160) return 15000000; if (h >= 1080) return 5000000;
  if (h >= 720)  return 2500000;  return 1500000;
}

function escM3U8(s)   { return (s || '').replace(/"/g, '\\"'); }
function safeId(name) { return Buffer.from(name).toString('base64').replace(/[/+=]/g, '_'); }

function getFileSizeMB(fp) {
  try { return (fs.statSync(fp).size / (1024 * 1024)).toFixed(1) + ' MB'; }
  catch { return '?'; }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const n of Object.keys(nets)) for (const net of nets[n])
    if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

// ──────────────────────────────────────────────────────────
// Start — detect GPU then listen
// ──────────────────────────────────────────────────────────
promptGpu().then(gpu => {
  GPU = gpu;
  const limit = readCacheLimitGB();
  const ip    = getLocalIp();
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   🎬  Home Streaming Server            ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Local:      http://localhost:${PORT}      ║`);
  console.log(`║  Network:    http://${ip}:${PORT}     ║`);
  console.log(`║  GPU:        ${String(GPU ? GPU.label : 'None (CPU libx264)').padEnd(22)} ║`);
  console.log(`║  Cache limit:${String(limit + ' GB').padEnd(22)} ║`);
  console.log('╚═══════════════════════════════════════╝\n');

  app.listen(PORT, '0.0.0.0');
});