// The Windows fixture encodes the latest drag position into the video itself.
// The receiver uses its own clock for the input and the returned video frame.
export const dragTarget = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#163859;color:white;font:34px system-ui;display:grid;height:100vh;place-content:center;text-align:center;user-select:none}
  #bits{position:absolute;inset:0 0 auto;height:12vh;display:flex}#bits i{flex:1;background:black}
  #scroll{position:absolute;inset:76vh 25% 8vh;overflow:auto;border:2px solid #73b0d4;font-size:24px}
  #scroll p{box-sizing:border-box;min-height:100%;margin:0;padding:.8em}
  #scroll p+p{background:#235543}
</style><div id="bits"><i></i><i></i><i></i><i></i><i></i><i></i></div>
<h1>拖拽延迟测试</h1><p>用一根手指从画面左侧匀速拖到右侧，约 3 秒</p>
<section id="scroll"><p>双指在这里向上滑动</p><p>滚动成功 · 双指向下滑可返回</p></section>
<script>
  const cells = document.querySelectorAll('#bits i');
  window.addEventListener('mousemove', event => {
    if (!(event.buttons & 1)) return;
    const zone = Math.max(0, Math.min(31, Math.floor(event.clientX * 32 / innerWidth))) + 1;
    cells.forEach((cell, bit) => { cell.style.background = zone & (1 << bit) ? 'white' : 'black'; });
  });
</script>`

export const dragReceiverProbe = `
(() => {
  const video = document.querySelector('video');
  const area = video.parentElement;
  const probe = document.createElement('output');
  probe.id = 'drag-probe';
  probe.textContent = '连上后，用一根手指从画面左侧匀速拖到右侧';
  area.append(probe);
  const canvas = document.createElement('canvas');
  canvas.width = 60;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let finger;
  let lastFrame;
  let lastInput = -1;
  let finished = false;
  let finishTimer;
  const pending = new Map();
  const samples = [];

  function summarize() {
    finished = true;
    pending.clear();
    if (samples.length < 8) {
      probe.textContent = '有效样本 ' + samples.length + ' 个，请从左到右再拖一次';
      return;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = p => Math.round(sorted[Math.ceil(sorted.length * p) - 1]);
    const summary = { samples: sorted.length, p50: percentile(.50), p95: percentile(.95) };
    probe.dataset.summary = JSON.stringify(summary);
    probe.textContent = '拖拽延迟 ' + summary.p50 + ' ms（中位数） / ' + summary.p95 + ' ms（P95），' + summary.samples + ' 个样本';
  }

  function measure(now, metadata) {
    if (video.videoWidth && video.videoHeight && !finished) {
      context.drawImage(video, 0, Math.floor(video.videoHeight * .05), video.videoWidth, 1, 0, 0, 60, 1);
      const data = context.getImageData(0, 0, 60, 1).data;
      let zone = 0;
      for (let bit = 0; bit < 6; bit++) if (data[(bit * 10 + 5) * 4] >= 128) zone |= 1 << bit;
      if (zone !== lastFrame && pending.has(zone)) {
        const elapsed = (metadata?.expectedDisplayTime ?? now) - pending.get(zone);
        if (elapsed >= 0 && elapsed < 1000) samples.push(elapsed);
        pending.delete(zone);
        probe.dataset.samples = String(samples.length);
      }
      lastFrame = zone;
    }
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(measure);
    else requestAnimationFrame(measure);
  }

  function zoneAt(event) {
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    return x >= 0 && x < 1 ? Math.floor(x * 32) + 1 : undefined;
  }
  area.addEventListener('pointerdown', event => {
    if (finger !== undefined || event.button !== 0 || !video.videoWidth || !area.classList.contains('touch-enabled') || (zoneAt(event) ?? 32) > 6) return;
    clearTimeout(finishTimer);
    finger = event.pointerId;
    finished = false;
    lastInput = -1;
    pending.clear();
    samples.length = 0;
    delete probe.dataset.summary;
    delete probe.dataset.samples;
    delete probe.dataset.inputZone;
    probe.textContent = '正在采样，继续向右拖动';
  }, true);
  area.addEventListener('pointermove', event => {
    if (event.pointerId !== finger || finished) return;
    const zone = zoneAt(event);
    if (zone !== undefined && zone > lastInput) {
      lastInput = zone;
      if (zone !== lastFrame) pending.set(zone, event.timeStamp);
      probe.dataset.inputZone = String(zone);
    }
  }, true);
  function stop(event) {
    if (event.pointerId !== finger) return;
    finger = undefined;
    if (event.type === 'pointerup') finishTimer = setTimeout(summarize, 500);
    else {
      pending.clear();
      probe.textContent = '拖动已中断，请从左到右再拖一次';
    }
  }
  area.addEventListener('pointerup', stop, true);
  area.addEventListener('pointercancel', stop, true);
  if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(measure);
  else requestAnimationFrame(measure);
})();
`

export const dragProbeStyle = `
#drag-probe{position:absolute;bottom:12px;left:12px;padding:8px 12px;background:#101916e8;color:white;border-radius:8px;pointer-events:none}
`
