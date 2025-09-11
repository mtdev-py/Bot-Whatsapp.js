require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const gTTS = require('gtts');
const sanitize = require('sanitize-filename');
const winston = require('winston');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console()
  ]
});

// Configurações
const OWNER_NUMBER = process.env.OWNER_NUMBER || '558188345519@s.whatsapp.net';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Rate-limiting
const rateLimits = new Map();
const RATE_LIMIT = { max: 5, windowMs: 60 * 1000 };

// Cache de metadados de grupo
const groupMetadataCache = new Map();

// ---------- HELPERS ----------
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function tmpPath(ext) {
  return path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.${sanitize(ext)}`);
}

async function getMediaBuffer(msg) {
  const types = ['imageMessage', 'videoMessage'];
  let message = msg.message;
  if (message?.extendedTextMessage?.contextInfo?.quotedMessage) {
    message = message.extendedTextMessage.contextInfo.quotedMessage;
  }
  for (const type of types) {
    if (message[type]) {
      const stream = await downloadContentFromMessage(message[type], type.replace('Message', '').toLowerCase());
      const buffer = await streamToBuffer(stream);
      if (buffer.length > 10 * 1024 * 1024) throw new Error('Mídia excede o limite de 10MB');
      return { buffer, kind: type.replace('Message', '').toLowerCase() };
    }
  }
  return null;
}

async function getGroupAdmins(jid) {
  if (!groupMetadataCache.has(jid)) {
    const meta = await sock.groupMetadata(jid);
    groupMetadataCache.set(jid, meta);
    setTimeout(() => groupMetadataCache.delete(jid), 5 * 60 * 1000);
  }
  const meta = groupMetadataCache.get(jid);
  return meta.participants.filter(p => p.admin).map(p => p.id);
}

async function isUserAdmin(jid, userJid) {
  const admins = await getGroupAdmins(jid);
  return admins.includes(userJid);
}

async function isBotAdmin(jid) {
  const meta = groupMetadataCache.get(jid) || await sock.groupMetadata(jid);
  const botBase = (sock.user.id || '').split(':')[0];
  const botJid = `${botBase}@s.whatsapp.net`;
  const bot = meta.participants.find(p => p.id === botJid);
  return !!bot?.admin;
}

// ---------- MENU ----------
async function buildMenu(jid, sender) {
  const isGroup = jid.endsWith('@g.us');
  return [
    '📖 *Menu de Comandos*',
    '',
    '🖼 *Figurinhas & IA*',
    '• !sticker / !fig / !s → imagem = estática; vídeo/GIF (até 8s) = animada',
    '• !gifsticker → figurinha animada',
    '• !ocr → extrai texto de uma imagem',
    '• !imgtr [pt|en...] → OCR + tradução',
    '',
    '👥 *Grupo*',
    '• !todos [msg] → marca todos',
    '',
    'ℹ️ *Observações*',
    '• Figurinhas: máx. 512x512, até 1MB.',
    (!GEMINI_API_KEY) ? '• Configure GEMINI_API_KEY para !ocr e !imgtr.' : ''
  ].filter(Boolean).join('\n');
}

// ---------- STICKERS ----------
async function imageToStickerWebp(imageBuffer, opts = {}) {
  const { size = 512, mode = 'cover' } = opts;
  try {
    const webpBuffer = await sharp(imageBuffer)
      .resize(size, size, {
        fit: mode,
        position: 'attention',
        background: mode === 'contain' ? { r: 0, g: 0, b: 0, alpha: 0 } : undefined,
        withoutEnlargement: false
      })
      .webp({ quality: 90, effort: 4 })
      .toBuffer();
    if (webpBuffer.length > 1024 * 1024) {
      throw new Error('Figurinha estática excede o limite de 1MB');
    }
    return webpBuffer;
  } catch (e) {
    logger.error(`Erro ao criar figurinha de imagem: ${e.message}`);
    throw new Error('Falha ao processar imagem para figurinha');
  }
}

async function videoToStickerWebp(videoBuffer, opts = {}) {
  const { maxDur = 8, fps = 10, size = 512, mode = 'cover' } = opts; // Reduz fps para 10 para menor tamanho
  const inPath = tmpPath('mp4');
  const outPath = tmpPath('webp');
  try {
    await fs.writeFile(inPath, videoBuffer);
    const filterComplex = mode === 'cover'
      ? `[0:v]scale=${size}:${size}:force_original_aspect_ratio=increase,setsar=1,crop=${size}:${size},fps=${fps}[v]`
      : [
          `color=c=black@0.0:s=${size}x${size}[base]`,
          `[0:v]scale=${size}:${size}:force_original_aspect_ratio=decrease,setsar=1[vid]`,
          `[base][vid]overlay=(W-w)/2:(H-h)/2:shortest=1,fps=${fps}[v]`
        ].join(';');
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .inputOptions(['-t 8']) // Limita o vídeo aos primeiros 8 segundos
        .noAudio()
        .complexFilter(filterComplex, ['v'])
        .outputOptions([
          '-loop', '0',
          '-vcodec', 'libwebp',
          '-lossless', '0',
          '-q:v', '50', // Reduz qualidade para manter tamanho baixo
          '-preset', 'default',
          '-an',
          '-vsync', '0'
        ])
        .save(outPath)
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)));
    });
    const webpBuffer = await fs.readFile(outPath);
    if (webpBuffer.length > 1024 * 1024) {
      throw new Error('Figurinha animada excede o limite de 1MB');
    }
    logger.info(`Figurinha gerada - Tamanho: ${(webpBuffer.length / 1024).toFixed(2)} KB`);
    return webpBuffer;
  } catch (e) {
    logger.error(`Erro ao criar figurinha de vídeo: ${e.message}`);
    throw new Error(`Falha ao criar figurinha de vídeo: ${e.message}`);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

async function enviarFigurinha(sock, jid, media) {
  try {
    let webp;
    if (media.kind === 'image') {
      webp = await imageToStickerWebp(media.buffer, { size: 512, mode: 'contain' });
    } else if (media.kind === 'video') {
      webp = await videoToStickerWebp(media.buffer, { size: 512, fps: 10, maxDur: 8, mode: 'contain' });
    } else {
      throw new Error('Tipo de mídia não suportado para figurinha');
    }
    await sock.sendMessage(jid, {
      sticker: webp,
      mimetype: 'image/webp', // Garante o mimetype correto
      isAnimated: media.kind === 'video' // Indica se é uma figurinha animada
    });
    logger.info(`Figurinha enviada para ${jid} - Tipo: ${media.kind}`);
  } catch (e) {
    logger.error(`Erro ao enviar figurinha: ${e.message}`);
    await sock.sendMessage(jid, { text: `❌ Erro ao enviar figurinha: ${e.message}` });
  }
}

// ---------- GRUPO ----------
async function marcarTodosInvisivel(jid, conteudo) {
  const meta = groupMetadataCache.get(jid) || await sock.groupMetadata(jid);
  const participants = meta.participants.map(p => p.id);
  await sock.sendMessage(jid, {
    text: `@everyone ${conteudo}`,
    mentions: participants
  });
}

// ---------- IA (GEMINI) ----------
async function ocrFromImageGemini(buffer) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  try {
    const result = await model.generateContent([
      { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } },
      { text: 'Extract text from this image' }
    ]);
    return result.response.text() || '';
  } catch (e) {
    logger.error(`Erro no OCR: ${e.message}`);
    throw new Error('Falha ao extrair texto da imagem');
  }
}

async function ocrAndTranslateImageGemini(buffer, lang) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  try {
    const result = await model.generateContent([
      { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } },
      { text: `Extract text from this image and translate it to ${lang}` }
    ]);
    return result.response.text() || '';
  } catch (e) {
    logger.error(`Erro na tradução de imagem: ${e.message}`);
    throw new Error('Falha ao traduzir texto da imagem');
  }
}

// ---------- COMANDOS ----------
async function checkRateLimit(sender) {
  const now = Date.now();
  const userLimit = rateLimits.get(sender) || { count: 0, resetTime: now };
  if (now > userLimit.resetTime) {
    userLimit.count = 0;
    userLimit.resetTime = now + RATE_LIMIT.windowMs;
  }
  if (userLimit.count >= RATE_LIMIT.max) {
    throw new Error('Limite de comandos atingido. Tente novamente em alguns minutos.');
  }
  userLimit.count++;
  rateLimits.set(sender, userLimit);
}

async function handleMenu(sock, jid, sender) {
  const menu = await buildMenu(jid, sender);
  await sock.sendMessage(jid, { text: menu });
}

async function handleSticker(sock, jid, sender, msg) {
  const media = await getMediaBuffer(msg);
  if (!media) {
    await sock.sendMessage(jid, { text: '❌ Envie uma imagem, vídeo curto ou GIF (ou responda a um).' });
    return;
  }
  await enviarFigurinha(sock, jid, media);
}

async function handleOCR(sock, jid, sender, msg) {
  const media = await getMediaBuffer(msg);
  if (!media || media.kind !== 'image') {
    await sock.sendMessage(jid, { text: '❌ Envie ou responda a uma *imagem* com !ocr.' });
    return;
  }
  const text = await ocrFromImageGemini(media.buffer);
  await sock.sendMessage(jid, { text: text ? `📝 *Texto reconhecido:*\n${text}` : '⚠️ Nenhum texto encontrado.' });
}

async function handleImageTranslate(sock, jid, sender, msg, texto) {
  if (typeof texto !== 'string') {
    await sock.sendMessage(jid, { text: '❌ Erro: Nenhum texto fornecido para !imgtr.' });
    return;
  }
  const args = texto.replace(/^\s*!imgtr\s*/i, '').trim();
  const lang = (args.split(/\s+/)[0] || 'pt').toLowerCase();
  const media = await getMediaBuffer(msg);
  if (!media || media.kind !== 'image') {
    await sock.sendMessage(jid, { text: '❌ Envie ou responda a uma *imagem* com !imgtr [lang].' });
    return;
  }
  const translated = await ocrAndTranslateImageGemini(media.buffer, lang);
  await sock.sendMessage(jid, { text: translated ? `🌐 *Tradução (${lang}):*\n${translated}` : '⚠️ Nenhum texto para traduzir.' });
}

async function handleTodos(sock, jid, sender, texto) {
  if (!jid.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: '❌ Este comando só funciona em grupos.' });
    return;
  }
  const normalizedSender = sender.replace(/:[0-9]+@/, '@').replace(/[^0-9@s.whatsapp.net]/g, '');
  const normalizedOwner = OWNER_NUMBER.replace(/:[0-9]+@/, '@').replace(/[^0-9@s.whatsapp.net]/g, '');
  const isOwner = normalizedSender === normalizedOwner;
  logger.info(`Verificando !todos - Sender: ${sender}, Normalized Sender: ${normalizedSender}, Owner: ${OWNER_NUMBER}, Normalized Owner: ${normalizedOwner}, IsOwner: ${isOwner}`);
  const conteudo = typeof texto === 'string' ? texto.replace(/^\s*!todos\s*/i, '').trim() : '';
  await marcarTodosInvisivel(jid, conteudo);
}

async function handleTTS(sock, jid, sender, texto) {
  if (typeof texto !== 'string') {
    await sock.sendMessage(jid, { text: '❌ Erro: Nenhum texto fornecido para !tts.' });
    return;
  }
  const args = texto.replace(/^\s*!tts\s*/i, '').trim();
  const [lang, ...textArr] = args.split(/\s+/);
  const text = textArr.join(' ');
  if (!text || !lang) {
    await sock.sendMessage(jid, { text: '❌ Use: !tts [pt|en|es] texto' });
    return;
  }
  const outPath = tmpPath('mp3');
  try {
    await new Promise((resolve, reject) => {
      new gTTS(text, lang).save(outPath, (err) => (err ? reject(err) : resolve()));
    });
    const audio = await fs.readFile(outPath);
    await sock.sendMessage(jid, { audio, mimetype: 'audio/mpeg' });
  } catch (e) {
    logger.error(`Erro no TTS: ${e.message}`);
    await sock.sendMessage(jid, { text: '❌ Falha ao gerar áudio.' });
  } finally {
    await fs.unlink(outPath).catch(() => {});
  }
}

// Mapa de comandos
const commands = {
  'menu': { handler: handleMenu, aliases: ['help', 'ajuda'] },
  'sticker': { handler: handleSticker, aliases: ['fig', 's'] },
  'gifsticker': { handler: handleSticker },
  'ocr': { handler: handleOCR },
  'imgtr': { handler: handleImageTranslate },
  'todos': { handler: handleTodos },
  'tts': { handler: handleTTS }
};

// ---------- INICIALIZAÇÃO DO BOT ----------
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  sock = makeWASocket({ auth: state });
  sock.ev.on('connection.update', (update) => {
    const { qr, connection } = update;
    if (qr) {
      logger.info('Gerando QR code para autenticação');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      logger.warn('Conexão perdida, reconectando...');
      startBot();
    } else if (connection === 'open') {
      logger.info('✅ Bot conectado ao WhatsApp!');
    }
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;
    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || msg.participant || msg.key.remoteJid;
    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';
    logger.info(`Mensagem recebida - JID: ${jid}, Sender: ${sender}, Texto: ${texto}`);
    const match = texto.match(/^\s*!(\w+)/i);
    if (!match) return;
    const cmdName = match[1].toLowerCase();
    const cmd = Object.values(commands).find(c => c.aliases?.includes(cmdName) || c === commands[cmdName]);
    if (!cmd) return;
    try {
      await checkRateLimit(sender);
      await cmd.handler(sock, jid, sender, msg, texto);
    } catch (e) {
      logger.error(`Erro no comando ${cmdName}: ${e.message}`);
      await sock.sendMessage(jid, { text: `❌ Erro: ${e.message}` });
    }
  });
}
startBot();