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
  ScanLine,
  Send,
  ServerOff,
  Smartphone,
  Upload,
  Wifi,
} from '@lucide/vue';

const CHUNK_SIZE = 64 * 1024;
const rtcConfig: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

type Role = 'sender' | 'receiver';
type LogTarget = 'sender' | 'receiver';

interface CreateSessionResponse {
  sessionId: string;
  qrToken: string;
  receiveUrl: string;
  expiresIn: number;
  expiresAt: string;
  error?: string;
}

interface JoinSessionResponse {
  sessionId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  expiresAt: string;
  error?: string;
}

interface IncomingMetadata {
  type: 'metadata';
  name: string;
  size: number;
  mimeType: string;
}

interface SignalMessage {
  type: 'session-ready' | 'peer-ready' | 'offer' | 'answer' | 'ice-candidate' | 'transfer-start' | 'transfer-complete' | 'transfer-failed';
  role?: Role;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const route = useRoute();
const config = useRuntimeConfig();
const apiBase = config.public.apiBase as string;
const wsBase = config.public.wsBase as string;

const file = ref<File | null>(null);
const session = ref<CreateSessionResponse | null>(null);
const socket = shallowRef<WebSocket | null>(null);
const pc = shallowRef<RTCPeerConnection | null>(null);
const channel = shallowRef<RTCDataChannel | null>(null);
const senderLogs = ref<string[]>([]);
const receiverLogs = ref<string[]>([]);
const incoming = ref<ArrayBuffer[]>([]);
const incomingBytes = ref(0);
const incomingMeta = ref<IncomingMetadata | null>(null);
const incomingSession = ref<JoinSessionResponse | null>(null);
const receiverState = ref('Ready');
const downloadUrl = ref('');
const reftimer = ref('05:00');
const senderProgress = ref(0);
const transferState = ref<'idle' | 'waiting' | 'connected' | 'sending' | 'complete'>('idle');

const receiverSessionId = computed(() => typeof route.params.sessionId === 'string' ? route.params.sessionId : '');
const receiverToken = computed(() => typeof route.query.token === 'string' ? route.query.token : '');
const isReceiver = computed(() => Boolean(receiverSessionId.value));
const fileMeta = computed(() => file.value ? formatBytes(file.value.size) : 'Drop your file here or choose from device');
const qrUrl = computed(() => session.value ? `${apiBase}/api/transfers/${session.value.sessionId}/qr?token=${encodeURIComponent(session.value.qrToken)}` : '');
const receiverProgress = computed(() => incomingMeta.value ? Math.min(100, Math.round((incomingBytes.value / incomingMeta.value.size) * 100)) : 0);
const activeProgress = computed(() => isReceiver.value ? receiverProgress.value : senderProgress.value);
const hasSuccess = computed(() => transferState.value === 'complete' || Boolean(downloadUrl.value));
const timer = computed(() => reftimer.value);
const countdownProgress = computed(() => {
  const [minutes = '0', seconds = '0'] = timer.value.split(':');
  const remaining = Number(minutes) * 60 + Number(seconds);
  return Math.max(0, Math.min(100, (remaining / (session.value?.expiresIn || 300)) * 100));
});
const senderStatus = computed(() => {
  if (transferState.value === 'complete') return 'Transfer complete';
  if (transferState.value === 'sending') return 'Sending file...';
  if (transferState.value === 'connected') return 'Device connected';
  if (transferState.value === 'waiting') return 'Waiting for another device...';
  return 'Create a little gateway when your file is ready.';
});

let timerInterval: ReturnType<typeof setInterval> | undefined;

function log(target: LogTarget, text: string) {
  const logs = target === 'sender' ? senderLogs : receiverLogs;
  logs.value = [text, ...logs.value].slice(0, 8);
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp ? 1 : 0)} ${units[exp]}`;
}

function socketUrl(role: Role) {
  if (!session.value) throw new Error('Session belum dibuat.');
  return `${wsBase}/signaling?role=${role}&sessionId=${session.value.sessionId}&token=${encodeURIComponent(session.value.qrToken)}`;
}

function setupPeer(role: Role) {
  pc.value = new RTCPeerConnection(rtcConfig);
  pc.value.onicecandidate = ({ candidate }) => {
    if (candidate) socket.value?.send(JSON.stringify({ type: 'ice-candidate', candidate }));
  };

  socket.value!.onmessage = async ({ data }) => {
    const message = JSON.parse(data) as SignalMessage;
    if (message.type === 'peer-ready') {
      transferState.value = 'connected';
      if (role === 'sender') await createOffer();
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

async function createOffer() {
  const offer = await pc.value!.createOffer();
  await pc.value!.setLocalDescription(offer);
  socket.value?.send(JSON.stringify({ type: 'offer', offer }));
  log('sender', 'Device connected.');
}

async function sendFile() {
  if (!file.value || !channel.value) return;
  let sent = 0;
  transferState.value = 'sending';
  socket.value?.send(JSON.stringify({ type: 'transfer-start' }));
  channel.value.send(JSON.stringify({ type: 'metadata', name: file.value.name, size: file.value.size, mimeType: file.value.type || 'application/octet-stream' }));

  for (let offset = 0; offset < file.value.size; offset += CHUNK_SIZE) {
    const buffer = await file.value.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    while (channel.value.bufferedAmount > CHUNK_SIZE * 16) await new Promise((resolve) => setTimeout(resolve, 50));
    channel.value.send(buffer);
    sent += buffer.byteLength;
    senderProgress.value = Math.min(100, Math.round((sent / file.value.size) * 100));
  }

  channel.value.send(JSON.stringify({ type: 'done' }));
  socket.value?.send(JSON.stringify({ type: 'transfer-complete' }));
  transferState.value = 'complete';
  log('sender', 'Transfer complete.');
}

async function createSession() {
  if (!file.value) return log('sender', 'Choose a file first.');
  const response = await fetch(`${apiBase}/api/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: file.value.name, fileSize: file.value.size, mimeType: file.value.type }),
  });
  const body = await response.json() as CreateSessionResponse;
  if (!response.ok) return log('sender', body.error || 'Could not create session.');
  session.value = body;
  transferState.value = 'waiting';

  startTimer(new Date(body.expiresAt));
  log('sender', 'QR is ready for 5 minutes.');

  socket.value = new WebSocket(socketUrl('sender'));
  socket.value.onopen = () => {
    setupPeer('sender');
    channel.value = pc.value!.createDataChannel('file');
    channel.value.binaryType = 'arraybuffer';
    channel.value.onopen = sendFile;
    log('sender', 'Waiting for device...');
  };
}

function startTimer(expiresAt: Date) {
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const left = Math.max(0, expiresAt.getTime() - Date.now());
    const minutes = String(Math.floor(left / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    reftimer.value = `${minutes}:${seconds}`;
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

async function joinSession() {
  if (!receiverToken.value) return log('receiver', 'QR link is incomplete.');
  const response = await fetch(`${apiBase}/api/transfers/${receiverSessionId.value}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: receiverToken.value }),
  });
  const body = await response.json() as JoinSessionResponse;
  if (!response.ok) return log('receiver', body.error || 'Could not join session.');

  incomingSession.value = body;
  session.value = { ...body, qrToken: receiverToken.value, receiveUrl: '', expiresIn: 0 };
  receiverState.value = 'Connecting';
  transferState.value = 'connected';
  log('receiver', 'Device connected.');

  socket.value = new WebSocket(socketUrl('receiver'));
  socket.value.onopen = () => {
    setupPeer('receiver');
    pc.value!.ondatachannel = ({ channel: nextChannel }) => {
      channel.value = nextChannel;
      nextChannel.binaryType = 'arraybuffer';
      nextChannel.onmessage = receiveChunk;
    };
  };
}

function receiveChunk({ data }: MessageEvent<string | ArrayBuffer>) {
  if (typeof data === 'string') {
    const message = JSON.parse(data) as IncomingMetadata | { type: 'done' };
    if (message.type === 'metadata') {
      incomingMeta.value = message;
      receiverState.value = 'Receiving';
      transferState.value = 'sending';
      log('receiver', `Receiving ${message.name}.`);
    }
    if (message.type === 'done') finishDownload();
    return;
  }

  if (!incomingMeta.value) return;
  incoming.value.push(data);
  incomingBytes.value += data.byteLength;
}

function finishDownload() {
  if (!incomingMeta.value) return;
  const blob = new Blob(incoming.value, { type: incomingMeta.value.mimeType });
  downloadUrl.value = URL.createObjectURL(blob);
  receiverState.value = 'Complete';
  transferState.value = 'complete';
  log('receiver', 'File is ready to download.');
}

function onFileChange(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] || null;
  if (file.value) log('sender', 'File selected.');
}

function resetSender() {
  socket.value?.close();
  pc.value?.close();
  session.value = null;
  file.value = null;
  senderProgress.value = 0;
  transferState.value = 'idle';
  reftimer.value = '05:00';
  senderLogs.value = [];
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = undefined;
}

async function copyLink() {
  if (!session.value?.receiveUrl) return;
  await navigator.clipboard.writeText(session.value.receiveUrl);
  log('sender', 'Link copied.');
}

onBeforeUnmount(() => {
  socket.value?.close();
  pc.value?.close();
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
  if (timerInterval) clearInterval(timerInterval);
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
        <p class="lead">Share files directly between devices with a QR code. No permanent storage, and every session fades away after 5 minutes.</p>
        <div class="hero-actions">
          <a v-if="!isReceiver" class="button primary" href="#share-panel"><Upload :size="18" /> Choose a file</a>
          <button v-else class="primary" type="button" @click="joinSession"><ScanLine :size="18" /> Connect device</button>
          <span class="safe-note"><Wifi :size="16" /> Direct device transfer</span>
        </div>
      </div>

      <div class="hero-visual" aria-hidden="true">
        <span class="meadow-sun" />
        <span class="meadow-cloud cloud-left"><Cloud :size="42" /></span>
        <span class="meadow-cloud cloud-right"><Cloud :size="36" /></span>
        <span class="meadow-hill hill-one" />
        <span class="meadow-hill hill-two" />
        <div class="device laptop"><Laptop :size="44" /><span>Sender</span></div>
        <div class="flying-file"><Feather :size="28" /></div>
        <svg class="doodle-arrow" viewBox="0 0 260 120">
          <path d="M24 76 C 80 18, 152 108, 214 42" />
          <path d="M205 38 L226 39 L214 58" />
        </svg>
        <div class="mini-qr"><QrCode :size="70" /></div>
        <div class="device phone"><Smartphone :size="42" /><span>Receiver</span></div>
        <span class="doodle-wave" />
        <span class="floating-leaf leaf-one"><Leaf :size="18" /></span>
        <span class="floating-leaf leaf-two"><Leaf :size="15" /></span>
      </div>
    </section>

    <section v-if="!isReceiver" id="share-panel" class="share-grid">
      <div class="drop-card">
        <div class="card-head">
          <span class="icon-bubble coral"><FolderOpen :size="22" /></span>
          <div>
            <h2>Pick a file</h2>
            <p>Choose from this device. The file travels directly to your friend.</p>
          </div>
        </div>

        <label class="drop-zone" for="fileInput">
          <input id="fileInput" type="file" @change="onFileChange">
          <span class="upload-illustration"><File :size="42" /><Leaf :size="18" /></span>
          <strong>{{ file ? file.name : 'Drop your file here' }}</strong>
          <span>{{ file ? fileMeta : 'or choose from your device' }}</span>
        </label>

        <div v-if="file" class="file-preview">
          <span class="icon-bubble sky"><File :size="20" /></span>
          <div>
            <strong>{{ file.name }}</strong>
            <span>{{ formatBytes(file.size) }} - {{ file.type || 'application/octet-stream' }}</span>
          </div>
        </div>

        <div class="actions">
          <button class="primary" type="button" @click="createSession"><QrCode :size="18" /> Generate QR</button>
          <button class="secondary" type="button" :disabled="!session" @click="copyLink"><Link :size="18" /> Copy link</button>
        </div>
      </div>

      <div class="qr-card" :class="{ active: session }">
        <div class="card-head">
          <span class="icon-bubble mint"><QrCode :size="22" /></span>
          <div>
            <h2>Little gateway</h2>
            <p>
              {{ senderStatus }}
              <span v-if="transferState === 'waiting'" class="waiting-dots" aria-hidden="true"><i /><i /><i /></span>
            </p>
          </div>
        </div>

        <div class="qr-stage">
          <img v-if="qrUrl" alt="QR session ShareMe" :src="qrUrl">
          <div v-else class="empty-qr"><QrCode :size="86" /><span>QR preview</span></div>
          <span v-if="qrUrl" class="scan-line" />
        </div>

        <div class="countdown">
          <span><Clock3 :size="16" /> This little gateway closes in</span>
          <strong>{{ timer }}</strong>
          <span class="countdown-track" aria-hidden="true"><span :style="{ width: `${countdownProgress}%` }" /></span>
        </div>

        <div class="transfer-strip" :class="{ moving: ['connected', 'sending'].includes(transferState) }">
          <span><Laptop :size="20" /> Sender</span>
          <span class="dotted-line"><Feather :size="17" class="moving-file" /><Send :size="18" class="transfer-icon" /></span>
          <span><Smartphone :size="20" /> Receiver</span>
        </div>

        <div class="progress">
          <div :style="{ width: `${activeProgress}%` }" />
        </div>
        <p class="progress-copy" aria-live="polite">{{ activeProgress }}% - {{ senderStatus }}</p>

        <div v-if="hasSuccess" class="success-state">
          <Flower2 :size="34" />
          <div>
            <strong>Your file made it!</strong>
            <span>No copy was permanently stored on the server.</span>
          </div>
          <button class="secondary" type="button" @click="resetSender">Send another file</button>
        </div>

        <ol class="activity">
            <li v-for="(entry, index) in senderLogs" :key="`${index}-${entry}`">{{ entry }}</li>
        </ol>
      </div>
    </section>

    <section v-else class="receiver-panel">
      <div class="receive-card">
        <span class="icon-bubble sky"><ScanLine :size="24" /></span>
        <h2>Receive file</h2>
        <p>Connect to the temporary gateway and download when the file arrives.</p>

        <div class="file-preview">
          <span class="icon-bubble coral"><File :size="20" /></span>
          <div>
            <strong>{{ incomingSession?.fileName || 'Waiting for metadata' }}</strong>
            <span>{{ incomingSession ? `${formatBytes(incomingSession.fileSize)} - ${incomingSession.mimeType || 'application/octet-stream'}` : 'No file received yet' }}</span>
          </div>
        </div>

        <div class="actions">
          <button class="primary" type="button" @click="joinSession"><Wifi :size="18" /> Connect device</button>
          <a class="button secondary" :class="{ disabled: !downloadUrl }" :href="downloadUrl" :download="incomingMeta?.name"><Download :size="18" /> Download</a>
        </div>

        <div class="transfer-strip" :class="{ moving: ['connected', 'sending'].includes(transferState) }">
          <span><Laptop :size="20" /> Sender</span>
          <span class="dotted-line"><Feather :size="17" class="moving-file" /><ArrowRight :size="18" class="transfer-icon" /></span>
          <span><Smartphone :size="20" /> Receiver</span>
        </div>

        <div class="progress">
          <div :style="{ width: `${activeProgress}%` }" />
        </div>
        <p class="progress-copy" aria-live="polite">{{ activeProgress }}% - {{ receiverState }}</p>

        <div v-if="downloadUrl" class="success-state">
          <Flower2 :size="34" />
          <div>
            <strong>Your file made it!</strong>
            <span>No copy was permanently stored on the server.</span>
          </div>
        </div>

        <ol class="activity">
          <li v-for="(entry, index) in receiverLogs" :key="`${index}-${entry}`">{{ entry }}</li>
        </ol>
      </div>
    </section>

    <section v-if="!isReceiver" id="how-it-works" class="info-section">
      <div class="section-title">
        <h2>How it works</h2>
        <p>A small note, a little gateway, then the file arrives.</p>
      </div>
      <div class="step-grid">
        <article>
          <span>01</span>
          <File :size="28" />
          <h3>Pick a file</h3>
          <p>Place your file on the desk.</p>
        </article>
        <article>
          <span>02</span>
          <QrCode :size="28" />
          <h3>Scan QR</h3>
          <p>Open the little gateway on another device.</p>
        </article>
        <article>
          <span>03</span>
          <Feather :size="28" />
          <h3>File arrives</h3>
          <p>The file travels directly through the wind.</p>
        </article>
      </div>
    </section>

    <section v-if="!isReceiver" id="privacy" class="security-grid">
      <article><Send :size="24" /><strong>Direct transfer</strong><span>Files travel directly between devices.</span></article>
      <article><Clock3 :size="24" /><strong>5 minute session</strong><span>QR links automatically expire.</span></article>
      <article><ServerOff :size="24" /><strong>No permanent storage</strong><span>Your files are not permanently kept on our servers.</span></article>
    </section>

    <footer v-if="!isReceiver" class="footer">
      <strong>ShareMe</strong>
      <span>Simple temporary sharing with a calmer, hand-painted feel.</span>
    </footer>
  </main>
</template>
