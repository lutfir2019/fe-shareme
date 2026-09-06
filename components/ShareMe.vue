<script setup lang="ts">
import {
  ArrowRight,
  Clock3,
  Cloud,
  Download,
  Feather,
  File,
  Flower2,
  FolderOpen,
  Leaf,
  Link,
  Laptop,
  QrCode,
  RefreshCw,
  ScanLine,
  Send,
  ServerOff,
  Smartphone,
  Upload,
  Wifi,
  X,
} from '@lucide/vue';

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFER_SIZE = 1024 * 1024;
const rtcConfig: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

type Role = 'sender' | 'receiver';
type LogTarget = 'local' | 'remote';
type ConnectionStatus = 'idle' | 'waiting' | 'connecting' | 'connected' | 'expired' | 'failed';
type TransferStatus = 'preparing' | 'transferring' | 'completed' | 'failed';

interface CreateSessionResponse {
  sessionId: string;
  pairingToken: string;
  qrToken: string;
  pairingUrl: string;
  receiveUrl: string;
  expiresIn: number;
  expiresAt: string;
  signalingToken: string;
  serverTime?: string;
  error?: string;
}

interface JoinSessionResponse {
  sessionId: string;
  peerId: string;
  expiresIn: number;
  expiresAt: string;
  signalingToken: string;
  serverTime?: string;
  error?: string;
}

interface FileMetaMessage {
  type: 'file-meta';
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

interface ChannelMessage {
  type: 'file-ready' | 'file-reject' | 'file-complete' | 'file-abort' | 'file-error' | 'ping' | 'pong';
  transferId?: string;
  error?: string;
}

interface SignalMessage {
  type: 'session-ready' | 'peer-ready' | 'offer' | 'answer' | 'ice-candidate' | 'session-expired' | 'peer-disconnected';
  role?: Role;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  status?: string;
  expiresAt?: string;
}

interface ActiveTransfer {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  direction: 'send' | 'receive';
  progress: number;
  status: TransferStatus;
}

type WritableLike = {
  write: (chunk: BufferSource) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<WritableLike>;
  }>;
};

const route = useRoute();
const config = useRuntimeConfig();
const apiBase = config.public.apiBase as string;
const wsBase = config.public.wsBase as string;
const configuredMaxFileSize = Number(config.public.maxFileSize);
const maxFileSize = Number.isFinite(configuredMaxFileSize) && configuredMaxFileSize > 0 ? configuredMaxFileSize : 250 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 180;
const MAX_MIME_LENGTH = 120;
const TRANSFER_ID_RE = /^tr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const routeToken = computed(() => {
  const param = route.params.token;
  const rawToken = Array.isArray(param) ? param[0] : param;
  const token = typeof rawToken === 'string' ? rawToken : route.query.token;
  return typeof token === 'string' ? token.split(/[[(]/)[0] : '';
});
const role = computed<Role>(() => routeToken.value ? 'receiver' : 'sender');
const isReceiver = computed(() => role.value === 'receiver');

const sessionId = ref<string | null>(null);
const pairingToken = ref('');
const pairingUrl = ref('');
const signalingToken = ref('');
const expiresAt = ref<number | null>(null);
const timer = ref('05:00');
const connectionStatus = ref<ConnectionStatus>('idle');
const currentFile = ref<File | null>(null);
const activeTransfer = ref<ActiveTransfer | null>(null);
const pendingIncoming = ref<FileMetaMessage | null>(null);
const socket = shallowRef<WebSocket | null>(null);
const pc = shallowRef<RTCPeerConnection | null>(null);
const channel = shallowRef<RTCDataChannel | null>(null);
const writable = shallowRef<WritableLike | null>(null);
const logs = ref<string[]>([]);
const incomingBytes = ref(0);
const serverClockOffset = ref(0);
const downloadUrl = ref('');
const downloadFileName = ref('');

let timerInterval: ReturnType<typeof setInterval> | undefined;
let sendAbort = false;
let writeChain: Promise<void> = Promise.resolve();
let incomingChunks: BlobPart[] = [];

const fileMeta = computed(() => currentFile.value ? `${currentFile.value.name} - ${formatBytes(currentFile.value.size)}` : 'or choose from your device');
const qrUrl = computed(() => sessionId.value && pairingToken.value ? `${apiBase}/api/sessions/${sessionId.value}/qr?token=${encodeURIComponent(pairingToken.value)}` : '');
const countdownProgress = computed(() => {
  if (!expiresAt.value) return 100;
  const remaining = Math.max(0, expiresAt.value - Date.now()) / 1000;
  return Math.max(0, Math.min(100, (remaining / 300) * 100));
});
const statusCopy = computed(() => {
  if (connectionStatus.value === 'connected') return 'Connected';
  if (connectionStatus.value === 'connecting') return 'Connecting';
  if (connectionStatus.value === 'waiting') return 'Waiting for another device';
  if (connectionStatus.value === 'expired') return 'Session expired';
  if (connectionStatus.value === 'failed') return 'Connection failed';
  return 'Create a little gateway';
});
const isTransferLocked = computed(() => Boolean(activeTransfer.value && activeTransfer.value.status !== 'completed' && activeTransfer.value.status !== 'failed'));
const canSend = computed(() => Boolean(currentFile.value && channel.value?.readyState === 'open' && connectionStatus.value === 'connected' && !isTransferLocked.value));

function log(_target: LogTarget, text: string) {
  logs.value = [text, ...logs.value].slice(0, 5);
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp ? 1 : 0)} ${units[exp]}`;
}

function makeTransferId() {
  return `tr_${crypto.randomUUID()}`;
}

function sanitizeFileName(name: string) {
  const cleaned = name.replace(/[\/\\\0-\x1F\x7F]/g, '_').trim().slice(0, MAX_FILENAME_LENGTH);
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'download';
}

function safeMimeType(type: unknown) {
  return typeof type === 'string' && type.length <= MAX_MIME_LENGTH ? type : 'application/octet-stream';
}

function transferProgress(done: number, total: number) {
  return total <= 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
}

function validateIncomingMeta(message: FileMetaMessage | ChannelMessage) {
  if (message.type !== 'file-meta') return null;
  if (!TRANSFER_ID_RE.test(message.transferId)) return null;
  if (typeof message.fileName !== 'string') return null;
  if (!Number.isFinite(message.fileSize) || message.fileSize < 0 || message.fileSize > maxFileSize) return null;
  return {
    type: 'file-meta',
    transferId: message.transferId,
    fileName: sanitizeFileName(message.fileName),
    fileSize: message.fileSize,
    mimeType: safeMimeType(message.mimeType),
  } satisfies FileMetaMessage;
}

function startTimer(nextExpiresAt: string, serverTime?: string) {
  expiresAt.value = new Date(nextExpiresAt).getTime();
  serverClockOffset.value = serverTime ? new Date(serverTime).getTime() - Date.now() : 0;
  if (timerInterval) clearInterval(timerInterval);

  const tick = () => {
    if (!expiresAt.value) return;
    const left = Math.max(0, expiresAt.value - (Date.now() + serverClockOffset.value));
    const minutes = String(Math.floor(left / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    timer.value = `${minutes}:${seconds}`;
    if (left <= 0) expireClientSession();
  };

  tick();
  timerInterval = setInterval(tick, 1000);
}

function socketUrl(nextRole: Role, nextSessionId = sessionId.value) {
  if (!nextSessionId || !signalingToken.value) throw new Error('Session belum siap.');
  return `${wsBase}/signaling?role=${nextRole}&sessionId=${nextSessionId}&signalToken=${encodeURIComponent(signalingToken.value)}`;
}

function setupPeer(nextRole: Role) {
  pc.value = new RTCPeerConnection(rtcConfig);
  pc.value.onicecandidate = ({ candidate }) => {
    if (candidate) socket.value?.send(JSON.stringify({ type: 'ice-candidate', candidate }));
  };

  if (nextRole === 'sender') {
    const nextChannel = pc.value.createDataChannel('shareme-files', { ordered: true });
    bindDataChannel(nextChannel);
  } else {
    pc.value.ondatachannel = ({ channel: nextChannel }) => bindDataChannel(nextChannel);
  }

  socket.value!.onmessage = async ({ data }) => {
    const message = JSON.parse(data) as SignalMessage;
    if (message.type === 'session-expired') return expireClientSession();
    if (message.type === 'peer-ready') {
      connectionStatus.value = 'connecting';
      if (nextRole === 'sender') await createOffer();
    }
    if (message.type === 'offer' && message.offer) {
      await pc.value?.setRemoteDescription(message.offer);
      const answer = await pc.value!.createAnswer();
      await pc.value!.setLocalDescription(answer);
      socket.value?.send(JSON.stringify({ type: 'answer', answer }));
    }
    if (message.type === 'answer' && message.answer) await pc.value?.setRemoteDescription(message.answer);
    if (message.type === 'ice-candidate' && message.candidate) await pc.value?.addIceCandidate(message.candidate);
  };
}

function bindDataChannel(nextChannel: RTCDataChannel) {
  channel.value = nextChannel;
  nextChannel.binaryType = 'arraybuffer';
  nextChannel.bufferedAmountLowThreshold = MAX_BUFFER_SIZE;
  nextChannel.onopen = () => {
    connectionStatus.value = 'connected';
    log('local', 'Devices connected. You can send files until the timer ends.');
  };
  nextChannel.onmessage = (event) => {
    void handleChannelMessage(event.data);
  };
  nextChannel.onclose = () => {
    if (connectionStatus.value !== 'expired') connectionStatus.value = 'failed';
  };
}

async function createOffer() {
  const offer = await pc.value!.createOffer();
  await pc.value!.setLocalDescription(offer);
  socket.value?.send(JSON.stringify({ type: 'offer', offer }));
}

async function createSession() {
  const response = await fetch(`${apiBase}/api/sessions`, { method: 'POST' });
  const body = await response.json() as CreateSessionResponse;
  if (!response.ok) return log('local', body.error || 'Could not create session.');

  sessionId.value = body.sessionId;
  pairingToken.value = body.pairingToken || body.qrToken;
  pairingUrl.value = body.pairingUrl || body.receiveUrl;
  signalingToken.value = body.signalingToken;
  connectionStatus.value = 'waiting';
  startTimer(body.expiresAt, body.serverTime);
  openSignaling('sender');
  log('local', 'Little gateway is ready for 5 minutes.');
}

async function joinSession() {
  const token = routeToken.value;
  if (!token) return log('local', 'Pairing token is missing.');

  connectionStatus.value = 'connecting';
  const response = await fetch(`${apiBase}/api/sessions/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await response.json() as JoinSessionResponse;
  if (!response.ok) {
    connectionStatus.value = 'failed';
    return log('local', body.error || 'Could not join session.');
  }

  sessionId.value = body.sessionId;
  signalingToken.value = body.signalingToken;
  startTimer(body.expiresAt, body.serverTime);
  openSignaling('receiver');
  log('local', 'Pairing token claimed. Connecting to peer...');
}

function openSignaling(nextRole: Role) {
  socket.value?.close();
  socket.value = new WebSocket(socketUrl(nextRole));
  socket.value.onopen = () => setupPeer(nextRole);
  socket.value.onclose = () => {
    if (connectionStatus.value !== 'expired' && connectionStatus.value !== 'connected') connectionStatus.value = 'failed';
  };
}

function clearDownloadUrl() {
  if (downloadUrl.value) {
    URL.revokeObjectURL(downloadUrl.value);
    downloadUrl.value = '';
  }
  downloadFileName.value = '';
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const selected = input.files?.[0] || null;
  currentFile.value = null;
  clearDownloadUrl();
  incomingChunks = [];
  pendingIncoming.value = null;
  activeTransfer.value = null;
  if (!selected) return;
  if (selected.size > maxFileSize) {
    clearFileInput();
    return log('local', `File is too large. Maximum size is ${formatBytes(maxFileSize)}.`);
  }
  currentFile.value = selected;
  log('local', 'Selected file replaced the previous one.');
}

async function waitForBufferLow() {
  const dataChannel = channel.value;
  if (!dataChannel || dataChannel.bufferedAmount <= MAX_BUFFER_SIZE) return;
  await new Promise<void>((resolve) => {
    dataChannel.onbufferedamountlow = () => {
      dataChannel.onbufferedamountlow = null;
      resolve();
    };
  });
}

async function sendSelectedFile() {
  const selected = currentFile.value;
  const dataChannel = channel.value;
  if (!selected || !dataChannel || isTransferLocked.value) return;
  if (selected.size > maxFileSize) return log('local', `File is too large. Maximum size is ${formatBytes(maxFileSize)}.`);

  sendAbort = false;
  clearDownloadUrl();
  activeTransfer.value = null;
  const transferId = makeTransferId();
  const fileName = sanitizeFileName(selected.name);
  const mimeType = safeMimeType(selected.type);
  activeTransfer.value = {
    transferId,
    fileName,
    fileSize: selected.size,
    mimeType,
    direction: 'send',
    progress: 0,
    status: 'preparing',
  };

  dataChannel.send(JSON.stringify({
    type: 'file-meta',
    transferId,
    fileName,
    fileSize: selected.size,
    mimeType,
  }));
  log('local', 'Waiting for receiver save location...');
}

async function streamCurrentFile() {
  const transfer = activeTransfer.value;
  const selected = currentFile.value;
  const dataChannel = channel.value;
  if (!transfer || !selected || !dataChannel) return;

  let sent = 0;
  transfer.status = 'transferring';
  socket.value?.send(JSON.stringify({ type: 'transfer-start' }));

  for (let offset = 0; offset < selected.size; offset += CHUNK_SIZE) {
    if (sendAbort || connectionStatus.value === 'expired') break;
    const chunk = await selected.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    await waitForBufferLow();
    dataChannel.send(chunk);
    sent += chunk.byteLength;
    transfer.progress = transferProgress(sent, selected.size);
  }

  if (sendAbort || connectionStatus.value === 'expired') {
    dataChannel.send(JSON.stringify({ type: 'file-abort', transferId: transfer.transferId }));
    return clearCurrentTransfer();
  }

  dataChannel.send(JSON.stringify({ type: 'file-complete', transferId: transfer.transferId }));
  socket.value?.send(JSON.stringify({ type: 'transfer-complete' }));
  transfer.status = 'completed';
  transfer.progress = 100;
  currentFile.value = null;
  clearFileInput();
  log('local', 'File sent. Pick another file to continue this session.');
}

async function handleChannelMessage(data: string | ArrayBuffer) {
  if (typeof data !== 'string') return writeIncomingChunk(data);

  let message: FileMetaMessage | ChannelMessage;
  try {
    message = JSON.parse(data) as FileMetaMessage | ChannelMessage;
  } catch {
    await failIncomingTransfer('Malformed transfer message.');
    return;
  }
  if (message.type === 'file-meta') {
    const incoming = validateIncomingMeta(message);
    if (!incoming || isTransferLocked.value) {
      channel.value?.send(JSON.stringify({ type: 'file-reject', transferId: typeof message.transferId === 'string' ? message.transferId : undefined, error: 'Invalid incoming file metadata.' }));
      return log('remote', 'Invalid incoming file metadata was rejected.');
    }
    await closeWriter();
    clearDownloadUrl();
    pendingIncoming.value = incoming;
    incomingBytes.value = 0;
    currentFile.value = null;
    activeTransfer.value = {
      transferId: incoming.transferId,
      fileName: incoming.fileName,
      fileSize: incoming.fileSize,
      mimeType: incoming.mimeType,
      direction: 'receive',
      progress: 0,
      status: 'preparing',
    };
    log('remote', 'Incoming file is waiting for your save location.');
  }
  if (message.type === 'file-ready' && activeTransfer.value?.direction === 'send') {
    void streamCurrentFile();
  }
  if (message.type === 'file-reject') {
    if (activeTransfer.value) activeTransfer.value.status = 'failed';
    log('remote', message.error || 'Transfer rejected.');
  }
  if (message.type === 'file-complete' && activeTransfer.value?.direction === 'receive') {
    await finishIncomingFile();
  }
  if (message.type === 'file-abort' || message.type === 'file-error') {
    if (activeTransfer.value) activeTransfer.value.status = 'failed';
    incomingChunks = [];
    await closeWriter(true);
  }
}

async function acceptIncomingFile() {
  const incoming = pendingIncoming.value;
  const dataChannel = channel.value;
  if (!incoming || !dataChannel) return;

  const picker = window as FilePickerWindow;
  try {
    incomingChunks = [];
    if (picker.showSaveFilePicker) {
      const handle = await picker.showSaveFilePicker({ suggestedName: incoming.fileName });
      writable.value = await handle.createWritable();
    } else {
      log('local', 'Direct save is unavailable. Browser download will start after receiving.');
    }

    writeChain = Promise.resolve();
    if (activeTransfer.value) activeTransfer.value.status = 'transferring';
    dataChannel.send(JSON.stringify({ type: 'file-ready', transferId: incoming.transferId }));
  } catch {
    dataChannel.send(JSON.stringify({ type: 'file-reject', transferId: incoming.transferId, error: 'Receiver cancelled save location.' }));
    clearCurrentTransfer();
  }
}

function rejectIncomingFile() {
  if (!pendingIncoming.value) return;
  channel.value?.send(JSON.stringify({ type: 'file-reject', transferId: pendingIncoming.value.transferId, error: 'Receiver declined the file.' }));
  clearCurrentTransfer();
}

function writeIncomingChunk(chunk: ArrayBuffer) {
  const transfer = activeTransfer.value;
  if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return;

  writeChain = writeChain.then(async () => {
    if (chunk.byteLength > CHUNK_SIZE || incomingBytes.value + chunk.byteLength > transfer.fileSize) {
      await failIncomingTransfer('Invalid incoming file chunk.');
      return;
    }
    incomingChunks.push(chunk);
    if (writable.value) await writable.value.write(chunk);
    incomingBytes.value += chunk.byteLength;
    transfer.progress = transferProgress(incomingBytes.value, transfer.fileSize);
  }).catch(async () => {
    await failIncomingTransfer('Could not write incoming file.');
  });
}

async function finishIncomingFile() {
  if (activeTransfer.value?.status !== 'transferring') return;
  await writeChain;
  if (!activeTransfer.value || incomingBytes.value !== activeTransfer.value.fileSize) {
    await failIncomingTransfer('Incoming file ended before all bytes arrived.');
    return;
  }
  const shouldAutoDownload = !writable.value;
  if (writable.value) await closeWriter();
  if (activeTransfer.value) startBrowserDownload(activeTransfer.value, shouldAutoDownload);
  if (activeTransfer.value) {
    activeTransfer.value.status = 'completed';
    activeTransfer.value.progress = 100;
  }
  incomingChunks = [];
  pendingIncoming.value = null;
  log('local', 'File received. The next incoming file will replace this view.');
}

async function failIncomingTransfer(error: string) {
  if (activeTransfer.value) activeTransfer.value.status = 'failed';
  incomingChunks = [];
  incomingBytes.value = 0;
  channel.value?.send(JSON.stringify({ type: 'file-error', transferId: activeTransfer.value?.transferId, error }));
  await closeWriter(true);
}

function startBrowserDownload(transfer: ActiveTransfer, autoDownload = true) {
  clearDownloadUrl();
  const blob = new Blob(incomingChunks, { type: transfer.mimeType });
  downloadUrl.value = URL.createObjectURL(blob);
  downloadFileName.value = transfer.fileName;
  if (autoDownload) downloadReceivedFile();
}

function downloadReceivedFile() {
  if (!downloadUrl.value || !downloadFileName.value) return;
  const link = document.createElement('a');
  link.href = downloadUrl.value;
  link.download = downloadFileName.value;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function closeWriter(abort = false) {
  if (!writable.value) return;
  const writer = writable.value;
  writable.value = null;
  if (abort && writer.abort) await writer.abort();
  else await writer.close();
}

function clearCurrentTransfer() {
  currentFile.value = null;
  clearFileInput();
  pendingIncoming.value = null;
  clearDownloadUrl();
  incomingChunks = [];
  incomingBytes.value = 0;
  activeTransfer.value = null;
  sendAbort = false;
}

function clearFileInput() {
  const input = document.getElementById('fileInput') as HTMLInputElement | null;
  if (input) input.value = '';
}

function sendAnother() {
  clearCurrentTransfer();
}

async function copyLink() {
  if (!pairingUrl.value) return;
  await navigator.clipboard.writeText(pairingUrl.value);
  log('local', 'Pairing link copied.');
}

async function expireClientSession() {
  if (connectionStatus.value === 'expired') return;
  connectionStatus.value = 'expired';
  sendAbort = true;
  await closeWriter(true);
  channel.value?.close();
  pc.value?.close();
  socket.value?.close();
  currentFile.value = null;
  pendingIncoming.value = null;
  clearDownloadUrl();
  incomingChunks = [];
  incomingBytes.value = 0;
  activeTransfer.value = null;
  pairingToken.value = '';
  pairingUrl.value = '';
  signalingToken.value = '';
  sessionId.value = null;
  if (timerInterval) clearInterval(timerInterval);
  timer.value = '00:00';
}

function resetSession() {
  void expireClientSession();
  connectionStatus.value = 'idle';
  timer.value = '05:00';
  logs.value = [];
}

onBeforeUnmount(() => {
  void expireClientSession();
});
</script>

<template>
  <main class="page-shell">
    <nav class="nav">
      <a href="/" class="brand">
        <span class="brand-mark"><Leaf :size="18" /></span>
        <span>ShareMe</span>
      </a>
      <div class="nav-links">
        <a href="#how-it-works">How it works</a>
        <a href="#privacy">Privacy</a>
        <a v-if="!isReceiver" href="#share-panel" class="nav-cta">Send file</a>
      </div>
    </nav>

    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow"><Feather :size="16" /> Misty meadow file share</span>
        <h1>Send files like passing a little note.</h1>
        <p class="lead">Pair once with a QR code, keep the peer connection alive, and pass one file at a time until the 5 minute session fades away.</p>
        <div class="hero-actions">
          <button v-if="!isReceiver && connectionStatus === 'idle'" class="primary" type="button" @click="createSession"><QrCode :size="18" /> Create gateway</button>
          <a v-else-if="!isReceiver" class="button primary" href="#share-panel"><Upload :size="18" /> Choose a file</a>
          <button v-else class="primary" type="button" :disabled="connectionStatus !== 'idle'" @click="joinSession"><ScanLine :size="18" /> Connect device</button>
          <span class="safe-note"><Wifi :size="16" /> One session, many single-file transfers</span>
        </div>
      </div>

      <div class="hero-visual" aria-hidden="true">
        <span class="meadow-sun" />
        <span class="meadow-cloud cloud-left"><Cloud :size="42" /></span>
        <span class="meadow-cloud cloud-right"><Cloud :size="36" /></span>
        <span class="meadow-hill hill-one" />
        <span class="meadow-hill hill-two" />
        <div class="device laptop"><Laptop :size="44" /><span>Peer A</span></div>
        <div class="flying-file"><Feather :size="28" /></div>
        <svg class="doodle-arrow" viewBox="0 0 260 120">
          <path d="M24 76 C 80 18, 152 108, 214 42" />
          <path d="M205 38 L226 39 L214 58" />
        </svg>
        <div class="mini-qr"><QrCode :size="70" /></div>
        <div class="device phone"><Smartphone :size="42" /><span>Peer B</span></div>
        <span class="doodle-wave" />
        <span class="floating-leaf leaf-one"><Leaf :size="18" /></span>
        <span class="floating-leaf leaf-two"><Leaf :size="15" /></span>
      </div>
    </section>

    <section id="share-panel" class="share-grid">
      <div class="session-card">
        <div class="session-top">
          <span class="status-pill" :class="connectionStatus"><i /> {{ statusCopy }}</span>
          <strong><Clock3 :size="16" /> {{ timer }}</strong>
        </div>

        <div v-if="connectionStatus === 'idle' && !isReceiver" class="status-card">
          <span class="icon-bubble mint"><QrCode :size="24" /></span>
          <h2>Create a little gateway</h2>
          <p>Pair once, then send files in either direction without making a new QR.</p>
          <button class="primary" type="button" @click="createSession"><QrCode :size="18" /> Create session</button>
        </div>

        <div v-else-if="connectionStatus === 'idle' && isReceiver" class="status-card">
          <span class="icon-bubble sky"><ScanLine :size="24" /></span>
          <h2>Join this gateway</h2>
          <p>Use the one-time token from the QR link to connect to the sender.</p>
          <button class="primary" type="button" @click="joinSession"><Wifi :size="18" /> Connect device</button>
        </div>

        <div v-else-if="connectionStatus === 'expired'" class="expired-card">
          <Flower2 :size="36" />
          <h2>This link has faded away.</h2>
          <p>The 5 minute session ended. Temporary file references were cleared.</p>
          <button v-if="!isReceiver" class="primary" type="button" @click="resetSession"><RefreshCw :size="18" /> Create new session</button>
        </div>

        <template v-else>
          <label class="drop-zone" for="fileInput">
            <input id="fileInput" type="file" :disabled="connectionStatus !== 'connected' || isTransferLocked" @change="onFileChange">
            <span class="upload-illustration"><File :size="42" /><Leaf :size="18" /></span>
            <strong>{{ currentFile ? currentFile.name : 'Drop your next file here' }}</strong>
            <span>{{ fileMeta }}</span>
          </label>

          <div v-if="currentFile" class="file-preview">
            <span class="icon-bubble sky"><File :size="20" /></span>
            <div>
              <strong>{{ currentFile.name }}</strong>
              <span>{{ formatBytes(currentFile.size) }} - {{ currentFile.type || 'application/octet-stream' }}</span>
            </div>
          </div>

          <div v-if="activeTransfer" class="active-transfer">
            <span class="transfer-label">{{ activeTransfer.direction === 'send' ? 'Sending' : 'Receiving' }}</span>
            <strong>{{ activeTransfer.fileName }}</strong>
            <span>{{ formatBytes(activeTransfer.fileSize) }} - {{ activeTransfer.status }}</span>
            <div class="progress"><div :style="{ width: `${activeTransfer.progress}%` }" /></div>
            <p class="progress-copy" aria-live="polite">{{ activeTransfer.progress }}%</p>

            <div v-if="activeTransfer.status === 'completed'" class="success-state">
              <Flower2 :size="34" />
              <div>
                <strong>{{ activeTransfer.direction === 'send' ? 'Your file made it!' : 'File received' }}</strong>
                <span>The previous file view will be replaced by the next transfer.</span>
              </div>
              <div class="success-actions">
                <button v-if="activeTransfer.direction === 'receive' && downloadUrl" class="primary" type="button" @click="downloadReceivedFile"><Download :size="18" /> Download again</button>
                <button class="secondary" type="button" @click="sendAnother">Send another</button>
              </div>
            </div>
          </div>

          <div v-if="pendingIncoming && activeTransfer?.status === 'preparing'" class="incoming-panel">
            <strong>Incoming file</strong>
            <span>{{ pendingIncoming.fileName }} - {{ formatBytes(pendingIncoming.fileSize) }}</span>
            <div class="actions">
              <button class="secondary" type="button" @click="rejectIncomingFile"><X :size="18" /> Decline</button>
              <button class="primary" type="button" @click="acceptIncomingFile"><Download :size="18" /> Receive</button>
            </div>
          </div>

          <div class="actions">
            <button class="primary" type="button" :disabled="!canSend" @click="sendSelectedFile"><Send :size="18" /> Send file</button>
            <button v-if="!isReceiver" class="secondary" type="button" :disabled="!pairingUrl || connectionStatus === 'connected'" @click="copyLink"><Link :size="18" /> Copy pairing link</button>
          </div>

          <div class="transfer-strip" :class="{ moving: connectionStatus === 'connected' || activeTransfer?.status === 'transferring' }">
            <span><Laptop :size="20" /> Peer A</span>
            <span class="dotted-line"><Feather :size="17" class="moving-file" /><ArrowRight :size="18" class="transfer-icon" /></span>
            <span><Smartphone :size="20" /> Peer B</span>
          </div>
        </template>
      </div>

      <div v-if="!isReceiver" class="qr-card" :class="{ active: qrUrl }">
        <div class="card-head">
          <span class="icon-bubble mint"><QrCode :size="22" /></span>
          <div>
            <h2>One-time pairing</h2>
            <p>The token is only for connecting the second device.</p>
          </div>
        </div>

        <div class="qr-stage">
          <img v-if="qrUrl" alt="QR session ShareMe" :src="qrUrl">
          <div v-else class="empty-qr"><QrCode :size="86" /><span>QR preview</span></div>
          <span v-if="qrUrl" class="scan-line" />
        </div>

        <div class="countdown">
          <span><Clock3 :size="16" /> Session expires in</span>
          <strong>{{ timer }}</strong>
          <span class="countdown-track" aria-hidden="true"><span :style="{ width: `${countdownProgress}%` }" /></span>
        </div>

        <ol class="activity">
          <li v-for="(entry, index) in logs" :key="`${index}-${entry}`">{{ entry }}</li>
        </ol>
      </div>
    </section>

    <section v-if="!isReceiver" id="how-it-works" class="info-section">
      <div class="section-title">
        <h2>How it works</h2>
        <p>One token, one connection, one active file at a time.</p>
      </div>
      <div class="step-grid">
        <article><span>01</span><QrCode :size="28" /><h3>Pair once</h3><p>The QR token is claimed once and then invalidated.</p></article>
        <article><span>02</span><Feather :size="28" /><h3>Send one file</h3><p>Select a single file, stream chunks, then release it.</p></article>
        <article><span>03</span><RefreshCw :size="28" /><h3>Send again</h3><p>Pick another file while the same connection stays alive.</p></article>
      </div>
    </section>

    <section v-if="!isReceiver" id="privacy" class="security-grid">
      <article><Send :size="24" /><strong>Bidirectional</strong><span>Either peer can send the next single file.</span></article>
      <article><Clock3 :size="24" /><strong>5 minute session</strong><span>TTL is never extended after pairing.</span></article>
      <article><ServerOff :size="24" /><strong>No file history</strong><span>No file list, queue, binary storage, or local persistence.</span></article>
    </section>

    <footer v-if="!isReceiver" class="footer">
      <strong>ShareMe</strong>
      <span>Pair once. Transfer one file. Replace. Expire cleanly.</span>
    </footer>
  </main>
</template>
