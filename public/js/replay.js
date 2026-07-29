/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Day Replay Animation ─────────────────────────────────────────────────────

const TARGET_REPLAY_DURATION_MS = 90_000; // always 90-second replay regardless of snapshot count

const replayState = {
  isPlaying: false,
  isPaused: false,
  currentFrameIndex: 0,
  snapshots: [],
  animationFrame: null,
  startTime: 0,
  playbackSpeed: 1, // computed in openReplayModal from snapshot count
};

// DOM elements
const elReplayModal    = document.getElementById('replay-modal');
const elReplayScrubber = document.getElementById('replay-scrubber');
const elReplayPlayBtn  = document.getElementById('replay-play-btn');
const elReplayPauseBtn = document.getElementById('replay-pause-btn');
const elReplayStopBtn  = document.getElementById('replay-stop-btn');
const elReplayTime     = document.getElementById('replay-time');
const elReplayStatus   = document.getElementById('replay-status');

// Open replay modal and load today's data
async function openReplayModal() {
  try {
    const resp = await fetch('/api/replay/today');
    const json = await resp.json();

    if (!json.ok || !json.replay) {
      alert('No replay data yet - telemetry needs to run for a little while first.');
      return;
    }

    const { snapshots } = json.replay;
    if (!snapshots || snapshots.length === 0) {
      alert('No energy flow data available for today.');
      return;
    }

    replayState.snapshots = snapshots;
    replayState.currentFrameIndex = 0;
    replayState.isPlaying = false;
    replayState.isPaused = false;
    // Compute speed so total replay always takes TARGET_REPLAY_DURATION_MS
    replayState.playbackSpeed = (snapshots.length * 1000) / TARGET_REPLAY_DURATION_MS;

    elReplayModal.style.display = 'block';
    updateReplayScrubber();
    renderReplayFrame();
  } catch (err) {
    console.error('Error loading replay:', err);
    alert('Failed to load replay data.');
  }
}

// Close replay modal
function closeReplayModal() {
  stopReplayAnimation();
  elReplayModal.style.display = 'none';
  replayState.snapshots = [];
}

// Start replay animation from current frame
function startReplayAnimation() {
  if (replayState.snapshots.length === 0) return;

  replayState.isPlaying = true;
  replayState.isPaused = false;
  // Correct: elapsed ms to reach currentFrameIndex
  const totalDuration = (replayState.snapshots.length * 1000) / replayState.playbackSpeed;
  replayState.startTime = performance.now() - (replayState.currentFrameIndex / replayState.snapshots.length) * totalDuration;

  elReplayPlayBtn.disabled = true;
  elReplayPauseBtn.disabled = false;
  if (elReplayStatus) elReplayStatus.textContent = '';

  animateReplay();
}

// Pause replay animation
function pauseReplayAnimation() {
  if (!replayState.isPlaying) return;

  replayState.isPlaying = false;
  replayState.isPaused = true;

  elReplayPlayBtn.disabled = false;
  elReplayPauseBtn.disabled = true;

  if (replayState.animationFrame) {
    cancelAnimationFrame(replayState.animationFrame);
    replayState.animationFrame = null;
  }
}

// Stop replay animation and reset to beginning
function stopReplayAnimation() {
  replayState.isPlaying = false;
  replayState.isPaused = false;
  replayState.currentFrameIndex = 0;

  elReplayPlayBtn.disabled = false;
  elReplayPauseBtn.disabled = true;

  if (replayState.animationFrame) {
    cancelAnimationFrame(replayState.animationFrame);
    replayState.animationFrame = null;
  }

  if (elReplayStatus) elReplayStatus.textContent = '';
  updateReplayScrubber();
  renderReplayFrame();
}

// Animation loop
function animateReplay() {
  const now = performance.now();
  const elapsed = now - replayState.startTime;
  const totalDuration = (replayState.snapshots.length * 1000) / replayState.playbackSpeed;

  if (elapsed >= totalDuration) {
    replayState.currentFrameIndex = replayState.snapshots.length - 1;
    replayState.isPlaying = false;
    renderReplayFrame();
    updateReplayScrubber();
    elReplayPlayBtn.disabled = false;
    elReplayPauseBtn.disabled = true;
    if (elReplayStatus) elReplayStatus.textContent = 'Done';
    return;
  }

  replayState.currentFrameIndex = Math.floor((elapsed / totalDuration) * replayState.snapshots.length);
  renderReplayFrame();
  updateReplayScrubber();

  if (replayState.isPlaying) {
    replayState.animationFrame = requestAnimationFrame(animateReplay);
  }
}

// ── Scrubber drag ─────────────────────────────────────────────────────────────

let _scrubDragging = false;
let _wasPlayingBeforeScrub = false;

function _scrubToClientX(clientX) {
  if (replayState.snapshots.length === 0) return;
  const track = elReplayScrubber ? elReplayScrubber.parentElement : null;
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  replayState.currentFrameIndex = Math.min(
    Math.floor(fraction * replayState.snapshots.length),
    replayState.snapshots.length - 1
  );
  renderReplayFrame();
  updateReplayScrubber();
}

function _onScrubStart(e) {
  if (replayState.snapshots.length === 0) return;
  _scrubDragging = true;
  _wasPlayingBeforeScrub = replayState.isPlaying;
  if (replayState.isPlaying) pauseReplayAnimation();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  _scrubToClientX(clientX);
  e.preventDefault();
  if (elReplayScrubber) elReplayScrubber.parentElement.classList.add('dragging');
}

function _onScrubMove(e) {
  if (!_scrubDragging) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  _scrubToClientX(clientX);
  if (e.cancelable) e.preventDefault();
}

function _onScrubEnd() {
  if (!_scrubDragging) return;
  _scrubDragging = false;
  if (elReplayScrubber) elReplayScrubber.parentElement.classList.remove('dragging');
  if (_wasPlayingBeforeScrub) {
    startReplayAnimation();
  }
}

// ── Scrubber UI update ────────────────────────────────────────────────────────

function updateReplayScrubber() {
  if (!elReplayScrubber) return;

  const n = replayState.snapshots.length;
  const fraction = n > 0 ? replayState.currentFrameIndex / n : 0;

  const track = elReplayScrubber.parentElement;
  const trackWidth = track ? track.getBoundingClientRect().width : 0;

  const thumb = elReplayScrubber.querySelector('.replay-scrubber-thumb');
  if (thumb) thumb.style.left = `${fraction * trackWidth}px`;

  const fill = document.getElementById('replay-progress-fill');
  if (fill) fill.style.width = `${fraction * 100}%`;

  if (n > 0 && replayState.currentFrameIndex < n) {
    const snapshot = replayState.snapshots[replayState.currentFrameIndex];
    const timeStr = new Date(snapshot.recorded_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    if (elReplayTime) elReplayTime.textContent = timeStr;
  }
}

// ── Frame rendering ───────────────────────────────────────────────────────────

function renderReplayFrame() {
  if (replayState.snapshots.length === 0) return;
  updateFlowDiagramForReplay(replayState.snapshots[replayState.currentFrameIndex]);
}

function updateFlowDiagramForReplay(snapshot) {
  const updateNode = (elId, watts) => {
    const el = document.getElementById(elId);
    if (el) el.textContent = `${Math.round(watts)} W`;
  };

  updateNode('solar-node-val', snapshot.solar_w);
  updateNode('home-node-val',  snapshot.house_w);
  updateNode('ev-node-val',    snapshot.tesla_w);
  updateNode('hw-node-val',    snapshot.hotwater_w);
  updateNode('ac-node-val',    snapshot.ac_w);
  updateNode('grid-node-val',  snapshot.grid_w);

  updateFlowPipes(snapshot);
}

function updateFlowPipes(snapshot) {
  const maxFlow = Math.max(snapshot.solar_w, snapshot.house_w, snapshot.tesla_w, 100);
  const norm = (w) => Math.max(0, Math.min(1, w / maxFlow));

  updatePipeStyle('solar-home', norm(Math.min(snapshot.solar_w, snapshot.house_w)));
  updatePipeStyle('home-grid',  norm(Math.max(0, snapshot.house_w + snapshot.tesla_w - snapshot.solar_w)));
  updatePipeStyle('home-ev',    norm(snapshot.tesla_w));
  updatePipeStyle('home-hw',    norm(snapshot.hotwater_w));
  updatePipeStyle('home-ac',    norm(snapshot.ac_w));
}

function updatePipeStyle(pipeClass, fraction) {
  const pipes = document.querySelectorAll(`.${pipeClass}`);
  for (const pipe of pipes) {
    const line = pipe.querySelector('.flow-pipe-line');
    if (line) {
      line.style.strokeWidth = `${1 + 7 * fraction}px`;
      line.style.opacity = Math.max(0.3, fraction);
    }
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

if (elReplayPlayBtn)  elReplayPlayBtn.addEventListener('click', startReplayAnimation);
if (elReplayPauseBtn) elReplayPauseBtn.addEventListener('click', pauseReplayAnimation);
if (elReplayStopBtn)  elReplayStopBtn.addEventListener('click', stopReplayAnimation);

if (elReplayScrubber) {
  const track = elReplayScrubber.parentElement;
  track.addEventListener('mousedown',  _onScrubStart);
  window.addEventListener('mousemove', _onScrubMove);
  window.addEventListener('mouseup',   _onScrubEnd);
  track.addEventListener('touchstart', _onScrubStart, { passive: false });
  window.addEventListener('touchmove',  _onScrubMove,  { passive: false });
  window.addEventListener('touchend',   _onScrubEnd);
}
