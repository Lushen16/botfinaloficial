'use strict';

/**
 * Servidor do canal PKA (lado robô), sem DLL e sem ler memória.
 *
 * Modelo do Shiba: o bot é o SERVIDOR do named pipe
 * `\\.\pipe\pka-runtime-2-<pid do jogo>`; o cliente do jogo conecta e empurra
 * estado/telemetria; o bot responde com comandos pelo mesmo pipe.
 *
 *   node tools/pka_channel_server.cjs --pid 1234
 *   node tools/pka_channel_server.cjs --pid 1234 --key-file native/pka_channel_key.txt
 *
 * Fase atual: handshake + log das primeiras amostras (kind 4/5). Comandos
 * entram depois que o handshake for confirmado no cliente real.
 */

const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const pid = Number(arg('pid', 0));
const keyFile = path.resolve(arg('key-file', path.join(__dirname, '..', 'native', 'pka_channel_key.txt')));
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('uso: node tools/pka_channel_server.cjs --pid <PID> [--key-file arquivo]');
  process.exit(2);
}
const key = fs.readFileSync(keyFile, 'utf8').trim();
if (!/^[a-f0-9]{32}$/iu.test(key)) {
  console.error('chave invalida em ' + keyFile);
  process.exit(2);
}

const KIND = { challenge: 1, authenticate: 2, welcome: 3, state: 4, telemetry: 5, automation: 6, startup: 7, ack: 10 };
const MAX_FRAME = 2105344;
const CLIENT_DOMAIN = 'PKA2/client\0';
const SERVER_DOMAIN = 'PKA2/server\0';
const pipeName = '\\\\.\\pipe\\pka-runtime-2-' + pid;

const proof = (domain, nonce) => crypto.createHmac('sha256', key)
  .update(Buffer.concat([Buffer.from(domain, 'utf8'), nonce,
    Buffer.from([pid & 255, (pid >> 8) & 255, (pid >> 16) & 255, (pid >> 24) & 255])]))
  .digest();

const frame = (kind, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt32LE(kind, 4);
  return Buffer.concat([head, payload]);
};

let connections = 0;
const server = net.createServer(socket => {
  connections += 1;
  const id = connections;
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'connect', connection: id }));
  const nonce = crypto.randomBytes(32);
  socket.write(frame(KIND.challenge, nonce));
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let telemetry = 0;

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) break;
      const length = buffer.readUInt32LE(0);
      const kind = buffer.readUInt32LE(4);
      if (length > MAX_FRAME) { socket.destroy(); return; }
      if (buffer.length < 8 + length) break;
      const payload = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);

      if (kind === KIND.authenticate) {
        const expected = proof(CLIENT_DOMAIN, nonce);
        if (payload.length !== expected.length || !crypto.timingSafeEqual(expected, payload)) {
          console.log(JSON.stringify({ at: new Date().toISOString(), event: 'auth-bad', connection: id }));
          socket.destroy();
          return;
        }
        authenticated = true;
        const welcome = Buffer.alloc(36);
        welcome.writeUInt32LE(pid, 0);
        proof(SERVER_DOMAIN, nonce).copy(welcome, 4);
        socket.write(frame(KIND.welcome, welcome));
        console.log(JSON.stringify({ at: new Date().toISOString(), event: 'authenticated', connection: id }));
        continue;
      }
      if (kind === KIND.telemetry) {
        telemetry += 1;
        const text = payload.toString('utf8');
        if (telemetry <= 3) console.log(JSON.stringify({ at: new Date().toISOString(), event: 'telemetry', connection: id, bytes: payload.length, sample: text.slice(0, 240) }));
        continue;
      }
      if (kind === KIND.state) {
        console.log(JSON.stringify({ at: new Date().toISOString(), event: 'state', connection: id, bytes: payload.length }));
        continue;
      }
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'frame', connection: id, kind, bytes: payload.length, authenticated }));
    }
  });
  socket.on('error', error => console.log(JSON.stringify({ at: new Date().toISOString(), event: 'error', connection: id, message: error.message })));
  socket.on('close', () => console.log(JSON.stringify({ at: new Date().toISOString(), event: 'close', connection: id, telemetry, authenticated })));
});

server.listen(pipeName, () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'listening', pipe: pipeName }));
});
