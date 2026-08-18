/* =========================================================================
   TRACE — metadata inspector
   -------------------------------------------------------------------------
   Everything below runs client-side using the File API + exifr (CDN)
   so the site works immediately with no backend.

   When you're ready to plug in ExifTool / Apache Tika / MediaInfo:
   1. Stand up the server in server-example.js (or your own).
   2. Set CONFIG.BACKEND_URL below.
   3. The "Send to backend →" button will POST the file (or URL) to
      `${CONFIG.BACKEND_URL}/api/metadata` and render whatever JSON
      your server returns in a "Deep Extraction (Server)" section.

      URL-mode files also NEED a backend: browsers block cross-origin
      fetches of arbitrary URLs (CORS), so "Analyze" on a pasted URL
      is sent straight to your server as { url } JSON — see the
      "Send to backend" section of server-example.js.
   ========================================================================= */

const CONFIG = {
  BACKEND_URL: "http://localhost:4000"
};

const ACCEPT_BY_TYPE = { image: 'image/*', video: 'video/*', audio: 'audio/*' };

/* ---------------------------- state ---------------------------- */
let activeType = 'image';       // 'image' | 'video' | 'audio' | 'url'
let currentFile = null;
let currentUrl = null;          // pasted URL, when activeType === 'url'
let currentObjectUrl = null;
let currentMeta = null;
const recentScans = [];         // [{ name, url, meta, kind }]
const MAX_RECENTS = 8;

/* ---------------------------- dom refs ---------------------------- */
const tabsEl         = document.getElementById('tabs');
const uploadBar       = document.getElementById('uploadBar');
const uploadInputArea = document.getElementById('uploadInputArea');
const uploadPh        = document.getElementById('uploadPh');
const urlInput         = document.getElementById('urlInput');
const submitArrow      = document.getElementById('submitArrow');
const fileInput        = document.getElementById('fileInput');

const uploadPreview = document.getElementById('uploadPreview');
const uploadPreviewMedia = document.getElementById('uploadPreviewMedia');
const uploadPreviewName = document.getElementById('uploadPreviewName');
const uploadPreviewMeta = document.getElementById('uploadPreviewMeta');
const uploadPreviewClear = document.getElementById('uploadPreviewClear');

const reportSection = document.getElementById('report');
const previewMedia   = document.getElementById('previewMedia');
const fnameEl        = document.getElementById('fname');
const fmetaEl        = document.getElementById('fmeta');
const sectionsEl      = document.getElementById('sections');
const reportTag        = document.getElementById('reportTag');
const reportTitle      = document.getElementById('reportTitle');
// Backend status is kept internal; no separate backend panel is shown.
const backendStatus = document.createElement('div');

const recentEmpty = document.getElementById('recentEmpty');
const recentList  = document.getElementById('recentList');
const howItWorksBtn = document.getElementById('howItWorksBtn');

/* ---------------------------- tabs ---------------------------- */
tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  [...tabsEl.children].forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  activeType = btn.dataset.type;

  if (activeType === 'url'){
    uploadPh.style.display = 'none';
    urlInput.style.display = 'block';
    urlInput.focus();
  } else {
    urlInput.style.display = 'none';
    uploadPh.style.display = 'block';
    uploadPh.textContent = currentFile ? currentFile.name : 'Drop a file here or click to browse';
    fileInput.accept = ACCEPT_BY_TYPE[activeType];
  }
});

howItWorksBtn.addEventListener('click', () => {
  document.getElementById('how').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------------------------- upload interactions ---------------------------- */
uploadInputArea.addEventListener('click', () => {
  if (activeType === 'url') { urlInput.focus(); return; }
  fileInput.click();
});

['dragenter','dragover'].forEach(evt => {
  uploadBar.addEventListener(evt, e => { e.preventDefault(); uploadBar.classList.add('drag'); });
});
['dragleave','dragend'].forEach(evt => {
  uploadBar.addEventListener(evt, e => { e.preventDefault(); uploadBar.classList.remove('drag'); });
});
uploadBar.addEventListener('drop', e => {
  e.preventDefault();
  uploadBar.classList.remove('drag');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) selectFile(file);
});

fileInput.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) selectFile(file);
});

function selectFile(file){
  currentFile = file;
  currentUrl = null;
  uploadInputArea.classList.add('has-file');
  uploadPh.textContent = file.name;

  const kind = file.type.split('/')[0];
  if (ACCEPT_BY_TYPE[kind]){
    activeType = kind;
    [...tabsEl.children].forEach(t => t.classList.toggle('active', t.dataset.type === kind));
    urlInput.style.display = 'none';
    uploadPh.style.display = 'block';
  }

  showUploadPreviewForFile(file);
}

function showUploadPreviewForFile(file){
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);

  uploadPreview.hidden = false;
  uploadPreviewName.textContent = file.name;
  uploadPreviewMeta.textContent = `${fmtBytes(file.size)} · ${file.type || 'unknown type'}`;
  uploadPreviewMedia.innerHTML = '';

  if (file.type.startsWith('image/')){
    const img = document.createElement('img');
    img.src = currentObjectUrl;
    img.alt = file.name;
    uploadPreviewMedia.appendChild(img);
  } else if (file.type.startsWith('video/')){
    const vid = document.createElement('video');
    vid.src = currentObjectUrl;
    vid.muted = true;
    vid.preload = 'metadata';
    uploadPreviewMedia.appendChild(vid);
  } else if (file.type.startsWith('audio/')){
    const icon = document.createElement('div');
    icon.textContent = '♫';
    icon.style.fontSize = '22px';
    uploadPreviewMedia.appendChild(icon);
  } else {
    uploadPreviewMedia.innerHTML = '<span class="url-preview">▤</span>';
  }
}

function showUploadPreviewForUrl(url){
  uploadPreview.hidden = false;
  uploadPreviewName.textContent = url;
  uploadPreviewMeta.textContent = 'Remote URL · ready to analyze';
  uploadPreviewMedia.innerHTML = '<span class="url-preview">↗</span>';
}

function clearSelectedContent(){
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  currentFile = null;
  currentUrl = null;
  fileInput.value = '';
  uploadInputArea.classList.remove('has-file');
  uploadPh.textContent = 'Drop a file here or click to browse';
  urlInput.value = '';
  uploadPreview.hidden = true;
  uploadPreviewMedia.innerHTML = '';
  uploadPreviewName.textContent = '—';
  uploadPreviewMeta.textContent = '—';
}

urlInput.addEventListener('input', () => {
  const value = urlInput.value.trim();
  if (activeType === 'url' && value) {
    currentFile = null;
    currentUrl = value;
    showUploadPreviewForUrl(value);
  } else if (activeType === 'url') {
    currentUrl = null;
    uploadPreview.hidden = true;
  }
});

uploadPreviewClear.addEventListener('click', clearSelectedContent);

submitArrow.addEventListener('click', async () => {
  if (activeType === 'url'){
    const val = urlInput.value.trim();
    if (!val) { urlInput.focus(); return; }
    currentUrl = val;
    showUploadPreviewForUrl(val);
    await handleUrl(val);
  } else if (currentFile){
    await handleFile(currentFile);
  } else {
    fileInput.click();
  }
});

document.getElementById('clearBtn').addEventListener('click', () => {
  reportSection.classList.remove('show');
  clearSelectedContent();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('downloadBtn').addEventListener('click', () => {
  if (!currentMeta) return;
  const blob = new Blob([JSON.stringify(currentMeta, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (currentMeta.file?.name || 'trace-report').replace(/\.[^.]+$/, '') + '.metadata.json';
  a.click();
  URL.revokeObjectURL(url);
});

// Deep extraction is triggered automatically by Analyze; no separate backend submission is required.

/* ---------------------------- URL mode ---------------------------- */
async function handleUrl(url){
  currentUrl = url;
  showUploadPreviewForUrl(url);
  reportSection.classList.add('show');
  reportTitle.textContent = 'Reading trace…';
  reportTag.textContent = 'SCANNING…';
  reportTag.classList.remove('warn');
  sectionsEl.innerHTML = '';
  fnameEl.textContent = url;
  fmetaEl.textContent = 'Remote URL';
  previewMedia.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;color:var(--gray-dim);padding:20px;text-align:center">Preview unavailable for remote URLs until analyzed by a backend (browsers block cross-origin file reads).</div>`;

  currentMeta = { file: { name: url, type: 'url', sizeBytes: null, sizeReadable: '—', lastModified: null }, image: null, exif: null, gps: null, iptcXmp: null, video: null, server: null };
  currentFile = null;
  currentUrl = url;

  sectionsEl.appendChild(buildSection('File', {
    'URL': url,
    'Note': 'Local parsing needs the file bytes — connect a backend below to fetch and analyze this URL.',
  }));

  reportTitle.textContent = 'Report';
  reportTag.textContent = 'AWAITING BACKEND';
  reportTag.classList.add('warn');
  window.scrollTo({ top: reportSection.offsetTop - 80, behavior: 'smooth' });

  backendStatus.textContent = CONFIG.BACKEND_URL
    ? 'Ready — deep extraction will run automatically.'
    : 'Local URL preview ready — configure the backend for deep URL extraction.';
  backendStatus.classList.remove('ok','err');

  if (CONFIG.BACKEND_URL) await sendToBackend();
}

/* ---------------------------- main file handler ---------------------------- */
async function handleFile(file){
  currentFile = file;
  currentUrl = null;
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isAudio = file.type.startsWith('audio/');

  if (!currentObjectUrl) currentObjectUrl = URL.createObjectURL(file);

  reportSection.classList.add('show');
  reportTitle.textContent = 'Reading trace…';
  reportTag.textContent = 'SCANNING…';
  reportTag.classList.remove('warn');
  sectionsEl.innerHTML = '';
  fnameEl.textContent = file.name;
  fmetaEl.textContent = `${fmtBytes(file.size)} · ${file.type || 'unknown type'}`;

  previewMedia.innerHTML = '';
  if (isImage){
    const img = document.createElement('img'); img.src = currentObjectUrl; previewMedia.appendChild(img);
  } else if (isVideo){
    const vid = document.createElement('video'); vid.src = currentObjectUrl; vid.controls = true; vid.muted = true; previewMedia.appendChild(vid);
  } else if (isAudio){
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;padding:0 16px;';
    wrap.innerHTML = `<div style="font-size:34px;color:var(--cyan)">♫</div>`;
    const aud = document.createElement('audio'); aud.src = currentObjectUrl; aud.controls = true;
    wrap.appendChild(aud);
    previewMedia.appendChild(wrap);
  } else {
    previewMedia.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;color:var(--gray-dim)">No preview available</div>`;
  }

  const meta = {
    file: {
      name: file.name, type: file.type || 'unknown', sizeBytes: file.size,
      sizeReadable: fmtBytes(file.size),
      lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    },
    image: null, exif: null, gps: null, iptcXmp: null, video: null, audio: null, server: null,
  };

  window.scrollTo({ top: reportSection.offsetTop - 80, behavior: 'smooth' });

  if (isImage){
    try { meta.image = await getImageDimensions(currentObjectUrl); } catch (e) {}

    if (window.exifr){
      try {
        const parsed = await window.exifr.parse(file, { tiff:true, exif:true, gps:true, iptc:true, xmp:true, icc:false, ifd1:true });
        if (parsed){
          const { latitude, longitude, ...rest } = parsed;
          if (latitude != null && longitude != null) meta.gps = { latitude, longitude };
          meta.exif = pickFields(rest, CAMERA_KEYS);
          meta.iptcXmp = pickFields(rest, IPTC_XMP_KEYS);
        }
      } catch (e) { console.warn('exifr parse failed', e); }
    }
  } else if (isVideo){
    try { meta.video = await getVideoMeta(currentObjectUrl); } catch (e) {}
  } else if (isAudio){
    try { meta.audio = await getAudioMeta(currentObjectUrl); } catch (e) {}
    if (window.exifr){
      try {
        const parsed = await window.exifr.parse(file, { xmp: true, icc: false });
        const tags = pickFields(parsed || {}, IPTC_XMP_KEYS);
        if (tags) meta.iptcXmp = tags;
      } catch (e) { /* ID3 tags need a backend (ExifTool/Tika) for full support */ }
    }
  }

  currentMeta = meta;
  renderReport(meta, isImage, isVideo, isAudio);
  addRecent(file, currentObjectUrl, meta, isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file');

  reportTitle.textContent = 'Report';
  const hasRealMeta = meta.exif || meta.gps || meta.iptcXmp || meta.video || meta.audio;
  reportTag.textContent = hasRealMeta ? 'METADATA FOUND' : 'MINIMAL METADATA';
  reportTag.classList.toggle('warn', !hasRealMeta);

  backendStatus.textContent = CONFIG.BACKEND_URL
    ? 'Ready — deep extraction will run automatically.'
    : 'No backend configured — local analysis is still available.';
  backendStatus.classList.remove('ok','err');

  if (CONFIG.BACKEND_URL) await sendToBackend();
}

/* ---------------------------- helpers: extraction ---------------------------- */
function getImageDimensions(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, aspectRatio: +(img.naturalWidth / img.naturalHeight).toFixed(3) });
    img.onerror = reject;
    img.src = url;
  });
}

function getVideoMeta(url){
  return new Promise((resolve, reject) => {
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.onloadedmetadata = () => resolve({
      durationSeconds: +vid.duration.toFixed(2),
      durationReadable: fmtDuration(vid.duration),
      width: vid.videoWidth, height: vid.videoHeight,
      aspectRatio: vid.videoWidth && vid.videoHeight ? +(vid.videoWidth / vid.videoHeight).toFixed(3) : null,
    });
    vid.onerror = reject;
    vid.src = url;
  });
}

function getAudioMeta(url){
  return new Promise((resolve, reject) => {
    const aud = document.createElement('audio');
    aud.preload = 'metadata';
    aud.onloadedmetadata = () => resolve({
      durationSeconds: +aud.duration.toFixed(2),
      durationReadable: fmtDuration(aud.duration),
    });
    aud.onerror = reject;
    aud.src = url;
  });
}

const CAMERA_KEYS = ['Make','Model','LensModel','FNumber','ExposureTime','ISO','ISOSpeedRatings','FocalLength','FocalLengthIn35mmFormat','Flash','WhiteBalance','ExposureProgram','MeteringMode','Orientation','DateTimeOriginal','CreateDate','Software'];
const IPTC_XMP_KEYS = ['Copyright','Artist','Creator','Description','ImageDescription','Title','Keywords','Rights','Subject','CreatorTool','Rating','City','Country','State','Headline'];

function pickFields(obj, keys){
  const out = {};
  keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return Object.keys(out).length ? out : null;
}

function fmtBytes(bytes){
  if (bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtDuration(sec){
  if (!isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
function fmtValue(v){
  if (v instanceof Date) return v.toLocaleString();
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/* ---------------------------- render ---------------------------- */
function renderReport(meta, isImage, isVideo, isAudio){
  sectionsEl.innerHTML = '';

  sectionsEl.appendChild(buildSection('File', {
    'Name': meta.file.name, 'Type': meta.file.type, 'Size': meta.file.sizeReadable,
    'Last modified': meta.file.lastModified ? new Date(meta.file.lastModified).toLocaleString() : null,
  }));

  if (isImage){
    sectionsEl.appendChild(buildSection('Image', meta.image ? {
      'Width': meta.image.width + ' px', 'Height': meta.image.height + ' px', 'Aspect ratio': meta.image.aspectRatio,
    } : null, 'Dimensions unavailable'));

    sectionsEl.appendChild(buildSection('Camera / EXIF', meta.exif, 'No EXIF data embedded — likely stripped by an app, or this image never had a camera source.'));

    sectionsEl.appendChild(buildSection('GPS', meta.gps ? {
      'Latitude': meta.gps.latitude, 'Longitude': meta.gps.longitude, 'Map': null,
    } : null, 'No location data embedded — either stripped for privacy or never recorded.', meta.gps ? mapLink(meta.gps) : null));

    sectionsEl.appendChild(buildSection('IPTC / XMP', meta.iptcXmp, 'No caption, keyword, or rights metadata embedded.'));
  }

  if (isVideo){
    sectionsEl.appendChild(buildSection('Video', meta.video ? {
      'Duration': meta.video.durationReadable, 'Width': meta.video.width + ' px', 'Height': meta.video.height + ' px', 'Aspect ratio': meta.video.aspectRatio,
    } : null, 'Playback metadata unavailable'));
    sectionsEl.appendChild(buildSection('Codec / Stream Detail', null, 'Codec, bitrate, frame rate, and audio track detail require server-side extraction (MediaInfo). Connect your backend below to fetch it.'));
  }

  if (isAudio){
    sectionsEl.appendChild(buildSection('Audio', meta.audio ? { 'Duration': meta.audio.durationReadable } : null, 'Playback metadata unavailable'));
    sectionsEl.appendChild(buildSection('Tags (ID3 / XMP)', meta.iptcXmp, 'No embedded tags detected in-browser. Connect a backend (ExifTool/Tika) for full ID3/ID3v2 tag extraction.'));
    sectionsEl.appendChild(buildSection('Codec / Stream Detail', null, 'Bitrate, sample rate, and channel layout require server-side extraction (MediaInfo).'));
  }

  if (meta.server){
    sectionsEl.appendChild(buildSection('Deep Extraction (Server)', flattenForDisplay(meta.server)));
  }
}

function mapLink({ latitude, longitude }){
  const a = document.createElement('a');
  a.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
  a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open in Maps ↗'; a.style.fontWeight = '600';
  return a;
}

function buildSection(title, data, emptyText, extraLinkEl){
  const section = document.createElement('div');
  section.className = 'section';

  const head = document.createElement('div');
  head.className = 'section-head';
  const count = data ? Object.keys(data).length : 0;
  head.innerHTML = `<h3>${title}</h3><div style="display:flex;align-items:center;gap:10px"><span class="count">${data ? count + ' fields' : '—'}</span><span class="chev">▾</span></div>`;
  head.addEventListener('click', () => section.classList.toggle('closed'));
  section.appendChild(head);

  if (!data){
    const empty = document.createElement('div');
    empty.className = 'empty-section';
    empty.textContent = emptyText || 'Not available.';
    section.appendChild(empty);
    return section;
  }

  const body = document.createElement('div');
  body.className = 'section-body';
  Object.entries(data).forEach(([k, v]) => {
    const row = document.createElement('div'); row.className = 'kv';
    const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = humanizeKey(k);
    const vEl = document.createElement('span'); vEl.className = 'v';
    if (k === 'Map' && extraLinkEl){
      vEl.appendChild(extraLinkEl);
    } else {
      const val = fmtValue(v);
      vEl.textContent = val || '—';
      if (!val) vEl.classList.add('empty');
    }
    row.appendChild(kEl); row.appendChild(vEl);
    body.appendChild(row);
  });
  section.appendChild(body);
  return section;
}

function humanizeKey(k){ return k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()); }

function flattenForDisplay(obj, prefix = ''){
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenForDisplay(v, key));
    else out[key] = v;
  });
  return out;
}

/* ---------------------------- recent scans (sidebar) ---------------------------- */
function addRecent(file, url, meta, kind){
  recentScans.unshift({ name: file.name, url, meta, kind });
  if (recentScans.length > MAX_RECENTS){
    const removed = recentScans.pop();
    if (removed.url !== currentObjectUrl) URL.revokeObjectURL(removed.url);
  }
  renderRecents();
}

const KIND_GLYPH = { image: '◱', video: '▶', audio: '♫', file: '▤' };

function renderRecents(){
  recentList.innerHTML = '';
  recentEmpty.style.display = recentScans.length ? 'none' : 'block';

  recentScans.forEach((scan, i) => {
    const item = document.createElement('div');
    item.className = 'recent-item' + (i === 0 ? ' active' : '');

    const thumb = document.createElement('div');
    thumb.className = 'recent-thumb';
    if (scan.kind === 'image'){
      const img = document.createElement('img'); img.src = scan.url; thumb.appendChild(img);
    } else {
      thumb.innerHTML = `<span class="glyph">${KIND_GLYPH[scan.kind] || '▤'}</span>`;
    }

    const meta = document.createElement('div');
    meta.className = 'recent-meta';
    meta.innerHTML = `<div class="recent-name">${escapeHtml(scan.name)}</div><div class="recent-type">${scan.kind.toUpperCase()}</div>`;

    item.appendChild(thumb); item.appendChild(meta);
    item.addEventListener('click', () => {
      currentMeta = scan.meta;
      fnameEl.textContent = scan.meta.file.name;
      fmetaEl.textContent = `${scan.meta.file.sizeReadable} · ${scan.meta.file.type}`;
      previewMedia.innerHTML = '';
      if (scan.kind === 'image'){
        const img = document.createElement('img'); img.src = scan.url; previewMedia.appendChild(img);
      } else if (scan.kind === 'video'){
        const vid = document.createElement('video'); vid.src = scan.url; vid.controls = true; vid.muted = true; previewMedia.appendChild(vid);
      } else if (scan.kind === 'audio'){
        const aud = document.createElement('audio'); aud.src = scan.url; aud.controls = true; previewMedia.appendChild(aud);
      }
      renderReport(scan.meta, scan.kind === 'image', scan.kind === 'video', scan.kind === 'audio');
      reportSection.classList.add('show');
      [...recentList.children].forEach(c => c.classList.remove('active'));
      item.classList.add('active');
      window.scrollTo({ top: reportSection.offsetTop - 80, behavior: 'smooth' });
    });
    recentList.appendChild(item);
  });
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------------------- backend hookup ---------------------------- */
async function sendToBackend(){
  if (!currentFile && !currentUrl){
    backendStatus.textContent = 'Select a file or URL first.';
    backendStatus.classList.remove('ok');
    backendStatus.classList.add('err');
    return;
  }

  if (!CONFIG.BACKEND_URL){
    backendStatus.textContent = 'No backend configured — local analysis is still available.';
    backendStatus.classList.remove('ok');
    backendStatus.classList.add('err');
    return;
  }

  backendStatus.textContent = 'Deep extraction running automatically…';
  backendStatus.classList.remove('err','ok');

  try {
    let res;

    if (currentUrl){
      res = await fetch(`${CONFIG.BACKEND_URL}/api/metadata-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: currentUrl })
      });
    } else {
      const form = new FormData();
      form.append('file', currentFile);
      res = await fetch(`${CONFIG.BACKEND_URL}/api/metadata`, {
        method: 'POST',
        body: form
      });
    }

    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    const json = await res.json();
    currentMeta.server = json;

    const isImage = currentFile ? currentFile.type.startsWith('image/') : false;
    const isVideo = currentFile ? currentFile.type.startsWith('video/') : false;
    const isAudio = currentFile ? currentFile.type.startsWith('audio/') : false;

    renderReport(currentMeta, isImage, isVideo, isAudio);
    backendStatus.textContent = 'Deep extraction complete — report updated automatically.';
    backendStatus.classList.remove('err');
    backendStatus.classList.add('ok');
  } catch (err){
    console.error(err);
    backendStatus.textContent = `Deep extraction unavailable: ${err.message}. Local analysis is still available.`;
    backendStatus.classList.remove('ok');
    backendStatus.classList.add('err');
  }
}
