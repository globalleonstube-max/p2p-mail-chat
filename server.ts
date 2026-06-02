import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";

// Shared In-Memory State for the Node core
interface ChatMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  simulated?: boolean;
}

interface LogItem {
  id: string;
  timestamp: string;
  type: "info" | "success" | "error" | "input" | "network";
  message: string;
}

let nodeConfig = {
  email: "user@p2p-mail.net",
  password: "",
  imapServer: "imap.gmail.com",
  imapPort: 993,
  smtpServer: "smtp.gmail.com",
  smtpPort: 587,
  bootstrapEmails: ["assistant@p2p.net", "crypto-guard@p2p.net"],
  bootstrapUrl: "https://api.p2pchat.net/bootstrap",
};

let daemonRunning = false;
let daemonMode: "simulation" | "real" = "simulation";
let knownNodes = new Set<string>();
let messages: ChatMessage[] = [];
let logs: LogItem[] = [];
let activeChatContact: string | null = null;

// Multi-message compaction buffer (2-second interval)
interface SendBuffer {
  messages: Array<{ to: string; body: string }>;
  timer: NodeJS.Timeout | null;
}
const outBuffers = new Map<string, SendBuffer>();

// Server-Sent Events (SSE) subscribers
const sseStreams = new Set<express.Response>();

function emitSSE(type: string, data: any) {
  const payload = JSON.stringify({ type, data });
  for (const client of sseStreams) {
    client.write(`data: ${payload}\n\n`);
  }
}

function addLog(type: "info" | "success" | "error" | "input" | "network", message: string) {
  const logItem: LogItem = {
    id: Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toLocaleTimeString(),
    type,
    message,
  };
  logs.push(logItem);
  if (logs.length > 300) logs.shift();
  emitSSE("log", logItem);
}

// Lazy Gemini API initialization
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  if (!geminiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      geminiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
  }
  return geminiClient;
}

// Simulated AI node responder using Gemini
async function runSimulatedAIResponse(peerEmail: string, combinedMessage: string) {
  addLog("network", `[SMTP/IMAP SIM] P2P node ${peerEmail} received mail packet. Parsing body...`);
  const client = getGemini();
  if (!client) {
    // Fallback if key not set
    setTimeout(() => {
      receiveMessage(
        peerEmail,
        `[Node Daemon Simulation] Received your packet!\n(Install a Gemini API Key via 'Secrets' panel in settings for dynamic AI intelligence responses!)`
      );
    }, 1500);
    return;
  }

  let systemPrompt = "";
  if (peerEmail === "assistant@p2p.net") {
    systemPrompt = "You are a helpful, extremely clever AI assistant acting as a decenralised P2P node. Your communication channel is a secure Mail P2P Protocol. Reply in a concise, friendly, and clean manner. Write the reply directly as a email message body.";
  } else if (peerEmail === "crypto-guard@p2p.net") {
    systemPrompt = "You are 'Crypto Guard', a terminal security daemon node running in a custom Go operating shell over IMAP. You speak with high-level technical terms, giving helpful cybersecurity checklists, network encryption tips, and brief modern tech advice. Keep it to 1-2 structured paragraphs max.";
  } else {
    systemPrompt = "You are a decentralized P2P mail chat node. Reply normally to the message as an email.";
  }

  try {
    const modelRes = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Previous messages sent: \n${combinedMessage}\n\nFormulate your responsive node mail packet:`,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.8,
      },
    });

    const replyText = modelRes.text || "No response generated. Mail stream active.";
    // Simulate natural IMAP / network latency (1.5 - 3 seconds)
    const latency = 1200 + Math.random() * 1500;
    setTimeout(() => {
      receiveMessage(peerEmail, replyText);
    }, latency);

  } catch (err: any) {
    addLog("error", `Failed to fetch Gemini response: ${err.message || err}`);
    receiveMessage(peerEmail, `Hello from ${peerEmail}! (Gemini engine error, but node transport is healthy)`);
  }
}

// Message receiving handler (invoked by IMAP listener or Simulator)
function receiveMessage(fromEmail: string, bodyText: string) {
  if (!daemonRunning) return;

  const chatMsg: ChatMessage = {
    id: Math.random().toString(36).substr(2, 9),
    from: fromEmail,
    to: nodeConfig.email,
    body: bodyText,
    timestamp: new Date().toLocaleTimeString(),
    simulated: true,
  };

  messages.push(chatMsg);
  if (!knownNodes.has(fromEmail)) {
    knownNodes.add(fromEmail);
    addLog("success", `[P2P Discovery] Discovered and verified node: ${fromEmail}`);
    emitSSE("nodes", Array.from(knownNodes));
  }

  addLog("info", `[IMAP IDLE] Received packet from ${fromEmail} (Subject: [P2P-MSG])`);
  emitSSE("message", chatMsg);
}

// Queue and buffer message sends to simulate/implement outbox compaction
function enqueueMessage(toEmail: string, bodyText: string) {
  const chatMsg: ChatMessage = {
    id: Math.random().toString(36).substr(2, 9),
    from: nodeConfig.email,
    to: toEmail,
    body: bodyText,
    timestamp: new Date().toLocaleTimeString(),
  };

  messages.push(chatMsg);
  emitSSE("message", chatMsg);

  addLog("input", `[SMTP Queue] Buffered line for ${toEmail}: "${bodyText}"`);

  // Aggregate in buffer for 2 seconds
  let buf = outBuffers.get(toEmail);
  if (!buf) {
    buf = { messages: [], timer: null };
    outBuffers.set(toEmail, buf);
  }

  buf.messages.push({ to: toEmail, body: bodyText });

  if (buf.timer) {
    clearTimeout(buf.timer);
  }

  buf.timer = setTimeout(() => {
    outBuffers.delete(toEmail);
    flushBuffer(toEmail, buf!.messages);
  }, 2000);
}

// Flush and send compiled messages
async function flushBuffer(recipient: string, queued: Array<{ to: string; body: string }>) {
  const bodies = queued.map((q) => q.body);
  const combinedBody = bodies.join("\n---\n");

  addLog("network", `[SMTP OUT] Packaging aggregate of ${queued.length} text lines to ${recipient}`);
  addLog("info", `[SMTP SEND] Relaying MIME package to ${recipient} (MIME Subject: [P2P-MSG])`);

  if (daemonMode === "real") {
    // Attempt real SMTP relay if configured
    try {
      if (!nodeConfig.smtpServer || !nodeConfig.email || !nodeConfig.password) {
        throw new Error("SMTP server credentials not configured.");
      }

      const transporter = nodemailer.createTransport({
        host: nodeConfig.smtpServer,
        port: nodeConfig.smtpPort,
        secure: nodeConfig.smtpPort === 465,
        auth: {
          user: nodeConfig.email,
          pass: nodeConfig.password,
        },
      });

      await transporter.sendMail({
        from: nodeConfig.email,
        to: recipient,
        subject: "[P2P-MSG]",
        text: combinedBody,
      });

      addLog("success", `[SMTP RELAY] MIME packet successfully sent via SMTP socket to ${recipient}`);
    } catch (e: any) {
      addLog("error", `SMTP socket delivery failed: ${e.message || e}. Falling back to P2P simulation mode.`);
      daemonMode = "simulation";
      emitSSE("status", { running: daemonRunning, mode: daemonMode });
      // Trigger reply simulation as fallback
      if (recipient.endsWith("@p2p.net")) {
        runSimulatedAIResponse(recipient, combinedBody);
      }
    }
  } else {
    // Simulation Mode
    addLog("success", `[SMTP OK] Simulation outbox buffer delivered packet to local mailbox loop!`);
    if (recipient.endsWith("@p2p.net")) {
      runSimulatedAIResponse(recipient, combinedBody);
    }
  }
}

// Clean initialization of Daemon processes
function startDaemon(mode: "simulation" | "real") {
  if (daemonRunning) return;
  daemonRunning = true;
  daemonMode = mode;
  addLog("info", `----------------------------------------`);
  addLog("info", `Starting P2P Core Daemon (Node ID: ${nodeConfig.email})...`);
  addLog("success", `Core Event engine: online`);
  addLog("info", `Active listeners bound on secure SMTP & IMAP layers.`);

  // Clear existing nodes and seed default bootstrap configs
  knownNodes.clear();
  nodeConfig.bootstrapEmails.forEach((email) => knownNodes.add(email));

  // Run Bootstrap Flow
  addLog("network", `[Bootstrap Discovery] Triggering entry protocol via ${nodeConfig.bootstrapUrl}...`);
  setTimeout(() => {
    addLog("success", `[Bootstrap OK] Registered. Discovered initial nodes from directory.`);
    nodeConfig.bootstrapEmails.forEach((email) => {
      addLog("info", `[Bootstrap JOIN] Sent [P2P-JOIN] protocol handshake to ${email}`);
    });
    emitSSE("nodes", Array.from(knownNodes));
    emitSSE("status", { running: daemonRunning, mode: daemonMode });
  }, 1000);
}

function stopDaemon() {
  if (!daemonRunning) return;
  daemonRunning = false;
  addLog("info", `Stopping P2P Core Daemon...`);
  addLog("error", `Daemon stopped. All connections closed recursively.`);
  emitSSE("status", { running: daemonRunning, mode: daemonMode });
}

// Command interpreter simulating the Go readline terminal CLI
function executeCLICommand(rawText: string): string {
  const line = rawText.trim();
  addLog("input", `> ${line}`);

  if (line === "") return "";

  const args = line.split(/\s+/);
  const cmd = args[0].toLowerCase();

  // If we are actively in chat mode, any non-command goes directly to chat recipient
  if (activeChatContact) {
    if (line === "/exit") {
      const exiting = activeChatContact;
      activeChatContact = null;
      addLog("info", `Exited chat room with ${exiting}.`);
      emitSSE("activeChat", null);
      return `Exited chat room. Turned prompt back to general interface.`;
    }
    enqueueMessage(activeChatContact, line);
    return "";
  }

  switch (cmd) {
    case "help":
      return `Доступные команды:\n  status       - Проверить статус ядра P2P\n  nodes        - Вывести список известных узлов (peers)\n  chat <email> - Войти в диалог с указанным узлом\n  exit         - Выйти из приложения\n  help         - Показать эту справку`;
    case "status":
      return `Core daemon: ${daemonRunning ? "RUNNING (online)" : "STOPPED (offline)"}\nNode ID: ${nodeConfig.email}\nTransport Layer: Email SMTP/IMAP protocol\nKnown active peers in directory: ${knownNodes.size}\nBuffered aggregated channels: ${outBuffers.size}`;
    case "nodes":
      const list = Array.from(knownNodes).sort();
      if (list.length === 0) return "Список известных узлов пуст.";
      return `Список известных узлов сети:\n` + list.map((n, i) => `  [${i + 1}] ${n}`).join("\n");
    case "chat":
      if (args.length < 2) {
        return "Использование: chat <email_адрес>";
      }
      if (!daemonRunning) {
        return "Ошибка: Сначала запустите транспортное ядро Core Daemon!";
      }
      const peer = args[1].trim();
      activeChatContact = peer;
      addLog("success", `Entered interactive chat with peer: ${peer}`);
      emitSSE("activeChat", peer);
      // Retrieve history
      const history = messages.filter((m) => m.from === peer || m.to === peer);
      const historyLines = history
        .map((m) => `[${m.timestamp}] ${m.from === nodeConfig.email ? "Вы" : "Они"}: ${m.body}`)
        .join("\n");
      return `--- Чат с ${peer} (Для выхода наберите /exit) ---\n` + (historyLines || "История сообщений полностью пуста.");
    case "exit":
      return "Для завершения сеанса остановите Ядро из панели управления.";
    default:
      return `Команда "${cmd}" не распознана. Наберите "help" для получения списка команд.`;
  }
}

// Start up Express
async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // SSE Channel
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    sseStreams.add(res);

    // Initial state push
    res.write(`data: ${JSON.stringify({ type: "init", data: {
      config: nodeConfig,
      daemon: { running: daemonRunning, mode: daemonMode },
      nodes: Array.from(knownNodes),
      messages,
      logs,
      activeChat: activeChatContact
    } })}\n\n`);

    req.on("close", () => {
      sseStreams.delete(res);
    });
  });

  // REST endpoints
  app.get("/api/state", (req, res) => {
    res.json({
      config: nodeConfig,
      daemon: { running: daemonRunning, mode: daemonMode },
      nodes: Array.from(knownNodes),
      messages,
      logs,
      activeChat: activeChatContact,
    });
  });

  app.post("/api/config", (req, res) => {
    nodeConfig = { ...nodeConfig, ...req.body };
    addLog("info", `Configuration updated. Self node reset to ${nodeConfig.email}`);
    res.json({ status: "success", config: nodeConfig });
  });

  app.post("/api/daemon/start", (req, res) => {
    const { mode } = req.body;
    startDaemon(mode || "simulation");
    res.json({ status: "success", daemon: { running: daemonRunning, mode: daemonMode } });
  });

  app.post("/api/daemon/stop", (req, res) => {
    stopDaemon();
    res.json({ status: "success", daemon: { running: daemonRunning, mode: daemonMode } });
  });

  app.post("/api/command", (req, res) => {
    const { command } = req.body;
    const output = executeCLICommand(command);
    res.json({ output });
  });

  app.post("/api/message/send", (req, res) => {
    const { to, body } = req.body;
    if (!daemonRunning) {
      return res.status(400).json({ error: "Daemon is not running" });
    }
    enqueueMessage(to, body);
    res.json({ status: "success" });
  });

  app.post("/api/peer/add", (req, res) => {
    const { email } = req.body;
    if (email && !knownNodes.has(email)) {
      knownNodes.add(email);
      addLog("success", `[Discovery] Manually added verified peer address: ${email}`);
      emitSSE("nodes", Array.from(knownNodes));
    }
    res.json({ nodes: Array.from(knownNodes) });
  });

  // Vite Integration for both Dev and Production modes
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`P2P Mail Client app running on server port: ${PORT}`);
  });
}

startServer();
