import React, { useState, useEffect, useRef } from "react";
import {
  Shield,
  Activity,
  Terminal,
  MessageSquare,
  Users,
  Settings,
  Play,
  Square,
  Cpu,
  CornerDownLeft,
  UserPlus,
  Compass,
  AlertTriangle,
  RefreshCw,
  Mail,
  HelpCircle,
  Clock,
  ArrowRight,
  SlidersHorizontal
} from "lucide-react";

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

interface ConfigState {
  email: string;
  imapServer: string;
  imapPort: number;
  smtpServer: string;
  smtpPort: number;
  bootstrapEmails: string[];
  bootstrapUrl: string;
}

export default function App() {
  const [config, setConfig] = useState<ConfigState>({
    email: "user@p2p-mail.net",
    imapServer: "imap.gmail.com",
    imapPort: 993,
    smtpServer: "smtp.gmail.com",
    smtpPort: 587,
    bootstrapEmails: ["assistant@p2p.net", "crypto-guard@p2p.net"],
    bootstrapUrl: "https://api.p2pchat.net/bootstrap"
  });

  const [daemonState, setDaemonState] = useState({ running: false, mode: "simulation" });
  const [nodes, setNodes] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);

  interface NodePingInfo {
    latency: number | null;
    status: "online" | "offline" | "checking" | "unknown";
    lastChecked: string;
  }
  const [nodePings, setNodePings] = useState<Record<string, NodePingInfo>>({});

  // Tabs: "chat" or "terminal"
  const [activeTab, setActiveTab] = useState<"chat" | "terminal">("chat");

  // Input states
  const [chatInput, setChatInput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [manualPeerEmail, setManualPeerEmail] = useState("");
  const [showConfigAlert, setShowConfigAlert] = useState(false);
  const [logFilter, setLogFilter] = useState<"all" | "info" | "success" | "error" | "network">("all");

  // History tracking for terminal inputs
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Auto-scroll refs
  const chatEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Configure quick profiles for standard mail providers
  const fillProviderConfig = (provider: "gmail" | "yandex" | "outlook" | "yahoo") => {
    switch (provider) {
      case "gmail":
        setConfig((prev) => ({
          ...prev,
          imapServer: "imap.gmail.com",
          imapPort: 993,
          smtpServer: "smtp.gmail.com",
          smtpPort: 465
        }));
        break;
      case "yandex":
        setConfig((prev) => ({
          ...prev,
          imapServer: "imap.yandex.com",
          imapPort: 993,
          smtpServer: "smtp.yandex.com",
          smtpPort: 465
        }));
        break;
      case "outlook":
        setConfig((prev) => ({
          ...prev,
          imapServer: "outlook.office365.com",
          imapPort: 993,
          smtpServer: "smtp-mail.outlook.com",
          smtpPort: 587
        }));
        break;
      case "yahoo":
        setConfig((prev) => ({
          ...prev,
          imapServer: "imap.mail.yahoo.com",
          imapPort: 993,
          smtpServer: "smtp.mail.yahoo.com",
          smtpPort: 465
        }));
        break;
    }
  };

  // Synchronize state via SSE Connection
  useEffect(() => {
    const sse = new EventSource("/api/events");

    sse.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { type, data } = payload;

        switch (type) {
          case "init":
            setConfig(data.config);
            setDaemonState(data.daemon);
            setNodes(data.nodes);
            setMessages(data.messages);
            setLogs(data.logs);
            setActiveChat(data.activeChat);
            setNodePings(data.nodePings || {});
            break;
          case "status":
            setDaemonState(data);
            break;
          case "nodes":
            setNodes(data);
            break;
          case "nodePings":
            setNodePings(data);
            break;
          case "message":
            setMessages((prev) => [...prev, data]);
            break;
          case "log":
            setLogs((prev) => {
              const updated = [...prev, data];
              return updated.length > 500 ? updated.slice(1) : updated;
            });
            break;
          case "activeChat":
            setActiveChat(data);
            break;
        }
      } catch (e) {
        console.error("SSE parse error", e);
      }
    };

    sse.onerror = (err) => {
      console.warn("SSE connection interrupted, retrying...", err);
    };

    return () => {
      sse.close();
    };
  }, []);

  // Sync scroll on chat or log updates
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeChat, activeTab]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, activeTab]);

  // Handle configuration changes
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        setShowConfigAlert(true);
        setTimeout(() => setShowConfigAlert(false), 3000);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Manage core daemon state
  const handleToggleDaemon = async (mode: "simulation" | "real") => {
    try {
      if (daemonState.running) {
        await fetch("/api/daemon/stop", { method: "POST" });
      } else {
        await fetch("/api/daemon/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode })
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Trigger peer ping probe manually over the grid
  const handlePingNode = async (e: React.MouseEvent, nodeEmail: string) => {
    e.stopPropagation(); // Avoid switching current chat target on ping click
    if (!daemonState.running) return;
    try {
      await fetch("/api/peer/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: nodeEmail })
      });
    } catch (err) {
      console.error("Ping node trigger failed:", err);
    }
  };

  // Trigger CLI execution
  const postCLICommand = async (cmdText: string) => {
    if (!cmdText.trim()) return;

    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmdText })
      });
      const data = await res.json();

      // If output is generated, append it to the terminal screen mimicking standard command execution
      if (data.output) {
        // Output can contain lines that should appear in console logs
        // This is handled server side by appending logs.
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Chat window direct message triggers
  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !activeChat) return;

    try {
      await fetch("/api/message/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: activeChat, body: chatInput })
      });
      setChatInput("");
    } catch (err) {
      console.error(err);
    }
  };

  // CLI window command triggers
  const handleSendTerminalCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalInput.trim()) return;

    const cmd = terminalInput;
    setTerminalHistory((prev) => [cmd, ...prev]);
    setHistoryIndex(-1);
    setTerminalInput("");
    postCLICommand(cmd);
  };

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (terminalHistory.length > 0 && historyIndex < terminalHistory.length - 1) {
        const nextIdx = historyIndex + 1;
        setHistoryIndex(nextIdx);
        setTerminalInput(terminalHistory[nextIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setTerminalInput(terminalHistory[nextIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setTerminalInput("");
      }
    }
  };

  // Instantly start chat session with discovered nodes
  const handleSelectNodeChat = async (nodeEmail: string) => {
    setActiveTab("chat");
    await postCLICommand(`chat ${nodeEmail}`);
  };

  // Append new node peer manually
  const handleAddManualNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualPeerEmail.trim()) return;

    try {
      await fetch("/api/peer/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: manualPeerEmail.trim() })
      });
      setManualPeerEmail("");
    } catch (err) {
      console.error(err);
    }
  };

  // Filter messages specifically for the selected contact
  const currentChatHistory = messages.filter(
    (m) =>
      (m.from === activeChat && m.to === config.email) ||
      (m.from === config.email && m.to === activeChat)
  );

  // Filter logs based on active log filter category
  const filteredLogs = logs.filter((log) => {
    if (logFilter === "all") return true;
    return log.type === logFilter;
  });

  return (
    <div id="app_root" className="min-h-screen bg-sleek-bg font-sans text-[#e2e8f0] flex flex-col antialiased">
      {/* Upper Status / Header bar */}
      <header id="app_header" className="border-b border-sleek-border bg-sleek-card sticky top-0 z-30 px-6 py-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-[#3b82f6] rounded-md flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
            P
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
              P2P Mail Chat <span className="text-slate-500 text-xs font-mono ml-2">v1.0.4</span>
            </h1>
            <p className="text-[10px] text-[#22c55e] flex items-center font-mono">
              <span className={`w-2 h-2 rounded-full mr-2 ${daemonState.running ? "bg-[#22c55e] animate-pulse" : "bg-rose-500"}`} />
              {daemonState.running ? "CORE DAEMON RUNNING" : "CORE DAEMON OFFLINE"}
            </p>
          </div>
        </div>

        {/* Dynamic micro telemetry statistics indicators */}
        <div className="flex space-x-6 text-[11px] font-mono">
          <div className="flex flex-col">
            <span className="text-[#64748b] uppercase text-[9px] font-bold tracking-wider">IMAP Server</span>
            <span className="text-blue-400">{config.imapServer || "not set"}:{config.imapPort || 993}</span>
          </div>
          <div className="flex flex-col border-l border-sleek-border pl-6">
            <span className="text-[#64748b] uppercase text-[9px] font-bold tracking-wider">SMTP Server</span>
            <span className="text-blue-400">{config.smtpServer || "not set"}:{config.smtpPort || 587}</span>
          </div>
          <div className="flex flex-col border-l border-sleek-border pl-6">
            <span className="text-[#64748b] uppercase text-[9px] font-bold tracking-wider">Identity</span>
            <span className="text-[#e2e8f0]">{config.email}</span>
          </div>
        </div>
      </header>

      {/* Primary Layout Workspace Grid */}
      <main id="app_main" className="flex-1 w-full max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* LEFT COLUMN: Controls, Configs & Node sidebar */}
        <div id="side_panel" className="lg:col-span-4 flex flex-col gap-4">
          
          {/* Section A: Active Daemon launcher controls */}
          <div className="bg-sleek-card border border-sleek-border rounded-xl p-4 shadow-xl shadow-black/40 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-[#3b82f6] to-blue-600" />
            <div className="mb-3 flex justify-between items-center">
              <h2 className="font-bold text-white text-sm tracking-wide uppercase flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#3b82f6]" />
                Ядро сети (Core Daemon)
              </h2>
              {daemonState.running && (
                <span className="text-[10px] bg-[#3b82f6]/10 text-blue-400 border border-[#3b82f6]/20 px-2 py-0.5 rounded font-mono font-medium tracking-wider uppercase">
                  {daemonState.mode === "real" ? "REAL IMAP OUTBOX" : "SIMULATED NET"}
                </span>
              )}
            </div>

            <p className="text-xs text-slate-400 mb-4 font-normal leading-relaxed">
              Ядро Go демона запускается локально на порту 3000 и поддерживает непрерывные циклы IMAP IDLE
              и SMTP очередей отправки. Почтовые пакеты аккумулируются с двухсекундным буфером во избежание спам-блокировок.
            </p>

            <div className="grid grid-cols-1 gap-2.5">
              {!daemonState.running ? (
                <>
                  <button
                    onClick={() => handleToggleDaemon("simulation")}
                    className="w-full py-2.5 px-4 rounded-lg bg-[#22c55e] hover:bg-[#15803d] active:transform active:scale-95 transition-all text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/20 text-white cursor-pointer border border-[#22c55e]/35"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    Запустить в режиме симуляции (Рекомендуется)
                  </button>
                  <button
                    onClick={() => handleToggleDaemon("real")}
                    className="w-full py-2 px-4 rounded-lg bg-sleek-sidebar hover:bg-[#1a1d23] text-xs text-slate-300 border border-sleek-border transition flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Mail className="w-3.5 h-3.5 text-blue-400" />
                    Запустить с реальным SMTP / IMAP
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleToggleDaemon("simulation")}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#ef4444] hover:bg-rose-700 transition text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-rose-950/20 text-white cursor-pointer border border-[#ef4444]/35"
                >
                  <Square className="w-4 h-4 fill-current" />
                  Приостановить Core Daemon
                </button>
              )}
            </div>
          </div>

          {/* Section B: Node Discovery Directory */}
          <div className="bg-sleek-sidebar border border-sleek-border rounded-xl p-4 shadow-xl shadow-black/40 flex-1 flex flex-col">
            <h2 className="font-bold text-white text-sm tracking-wide uppercase mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-[#64748b] tracking-widest text-xs">
                <Users className="w-4 h-4 text-blue-400" />
                Known Nodes ({nodes.length})
              </span>
            </h2>

            <p className="text-xs text-slate-400 mb-4 leading-relaxed font-normal">
              Эти участники децентрализованной сети автоматически обнаружены во время Bootstrap-обмена или получены в фоновом MIME-рукопожатии <code>[P2P-JOIN]</code>.
            </p>

            {/* List of active nodes */}
            <div className="flex-1 overflow-y-auto max-h-[220px] rounded bg-[#0f1115] p-2 border border-sleek-border space-y-1.5 min-h-[140px]">
              {nodes.length === 0 ? (
                <div className="p-4 text-center text-slate-500 text-xs flex flex-col gap-2 justify-center items-center h-full">
                  <Compass className="w-6 h-6 shrink-0 text-slate-700" />
                  <span>Нет активных соединений с сетью. Запустите Ядро для выполнения Handshake.</span>
                </div>
              ) : (
                nodes.map((node) => {
                  const isSimPeer = node.endsWith("@p2p.net");
                  const isActive = activeChat === node;
                  const ping = nodePings[node];

                  // Calculate stats indicator colors and output
                  let dotColor = "bg-slate-600";
                  let pingText = "offline";
                  let isChecking = false;

                  if (ping) {
                    if (ping.status === "checking") {
                      dotColor = "bg-amber-400 animate-pulse";
                      pingText = "checking";
                      isChecking = true;
                    } else if (ping.status === "online") {
                      dotColor = "bg-[#22c55e]";
                      pingText = ping.latency ? `${ping.latency}ms` : "online";
                    } else if (ping.status === "offline") {
                      dotColor = "bg-rose-500";
                      pingText = "timeout";
                    } else {
                      dotColor = "bg-slate-500";
                      pingText = "unknown";
                    }
                  } else {
                    dotColor = isSimPeer ? "bg-blue-400" : "bg-slate-600";
                    pingText = "unknown";
                  }

                  return (
                    <button
                      key={node}
                      onClick={() => handleSelectNodeChat(node)}
                      className={`w-full text-left p-2 rounded border transition flex items-center justify-between gap-3 ${
                        isActive
                          ? "bg-[#3b82f6]/10 border-[#3b82f6]/20 text-[#3b82f6]"
                          : "bg-[#1a1d23]/40 border-transparent text-[#94a3b8] hover:bg-[#1a1d23] hover:text-[#e2e8f0]"
                      }`}
                    >
                      <div className="flex items-center gap-2 overflow-hidden flex-1">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                        <span className="text-xs truncate font-medium font-sans">
                          {node}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-1.5 shrink-0">
                        {pingText && (
                          <span className={`text-[9px] font-mono font-bold tracking-tight px-1.5 py-0.5 rounded leading-none ${
                            ping?.status === 'online' ? 'bg-[#22c55e]/15 text-emerald-400 border border-emerald-500/20' :
                            ping?.status === 'checking' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' :
                            ping?.status === 'offline' ? 'bg-rose-500/15 text-rose-400 border border-rose-500/20' : 'bg-slate-900/40 text-slate-500 border border-sleek-border'
                          }`}>
                            {pingText}
                          </span>
                        )}
                        
                        <button
                          type="button"
                          disabled={!daemonState.running}
                          onClick={(e) => handlePingNode(e, node)}
                          title="Отправить проверочный Heartbeat P2P-пакет"
                          className="p-1 rounded text-[#64748b] hover:text-blue-400 hover:bg-sleek-card transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        >
                          <Activity className={`w-3 h-3 ${isChecking ? "animate-pulse text-amber-450" : ""}`} />
                        </button>
                        
                        <ArrowRight className={`w-3.5 h-3.5 shrink-0 transition ${isActive ? "text-blue-400 rotate-90" : "text-slate-600"}`} />
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Add Manual Peer Node */}
            <form onSubmit={handleAddManualNode} className="mt-4 pt-3 border-t border-sleek-border">
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                Добавить узел вручную
              </label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={manualPeerEmail}
                  onChange={(e) => setManualPeerEmail(e.target.value)}
                  placeholder="name@server.com"
                  className="flex-1 bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-[#3b82f6]"
                />
                <button
                  type="submit"
                  className="bg-[#3b82f6] hover:bg-blue-600 p-2.5 rounded text-white transition cursor-pointer"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </div>
            </form>
          </div>

          {/* Section C: Transport Details (Configurations) */}
          <div className="bg-sleek-card border border-sleek-border rounded-xl p-4 shadow-xl shadow-black/40">
            <h2 className="font-bold text-white text-sm tracking-wide uppercase mb-3 flex items-center gap-2">
              <Settings className="w-4 h-4 text-slate-400" />
              Конфигурация (SMTP / IMAP)
            </h2>

            <div className="grid grid-cols-4 gap-1 mb-3">
              <button
                type="button"
                onClick={() => fillProviderConfig("gmail")}
                className="bg-[#0f1115] hover:bg-sleek-sidebar text-[10px] py-1 border border-sleek-border rounded text-center transition font-semibold text-slate-400 cursor-pointer"
              >
                G-Mail
              </button>
              <button
                type="button"
                onClick={() => fillProviderConfig("yandex")}
                className="bg-[#0f1115] hover:bg-sleek-sidebar text-[10px] py-1 border border-sleek-border rounded text-center transition font-semibold text-slate-400 cursor-pointer"
              >
                Yandex
              </button>
              <button
                type="button"
                onClick={() => fillProviderConfig("outlook")}
                className="bg-[#0f1115] hover:bg-sleek-sidebar text-[10px] py-1 border border-sleek-border rounded text-center transition font-semibold text-slate-400 cursor-pointer"
              >
                Outlook
              </button>
              <button
                type="button"
                onClick={() => fillProviderConfig("yahoo")}
                className="bg-[#0f1115] hover:bg-sleek-sidebar text-[10px] py-1 border border-sleek-border rounded text-center transition font-semibold text-slate-400 cursor-pointer"
              >
                Yahoo!
              </button>
            </div>

            <form onSubmit={handleSaveConfig} className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                  Личный Email адрес
                </label>
                <input
                  type="email"
                  value={config.email}
                  onChange={(e) => setConfig({ ...config, email: e.target.value })}
                  className="w-full bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-blue-400 font-mono focus:outline-none focus:border-[#3b82f6]"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Сервер SMTP
                  </label>
                  <input
                    type="text"
                    value={config.smtpServer}
                    onChange={(e) => setConfig({ ...config, smtpServer: e.target.value })}
                    className="w-full bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[#3b82f6]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Порт
                  </label>
                  <input
                    type="number"
                    value={config.smtpPort}
                    onChange={(e) => setConfig({ ...config, smtpPort: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[#3b82f6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Сервер IMAP
                  </label>
                  <input
                    type="text"
                    value={config.imapServer}
                    onChange={(e) => setConfig({ ...config, imapServer: e.target.value })}
                    className="w-full bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[#3b82f6]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Порт
                  </label>
                  <input
                    type="number"
                    value={config.imapPort}
                    onChange={(e) => setConfig({ ...config, imapPort: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[#0f1115] border border-sleek-border rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[#3b82f6]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                {showConfigAlert ? (
                  <span className="text-[11px] text-emerald-400 font-medium">
                    Конфигурация сохранена!
                  </span>
                ) : (
                  <span className="text-[10px] text-[#64748b]">
                    *Пароль задается в ENV-переменных
                  </span>
                )}
                <button
                  type="submit"
                  className="bg-[#3b82f6] hover:bg-blue-600 text-white font-semibold text-xs py-1.5 px-4 rounded flex items-center gap-1.5 transition cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  Применить параметры
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* RIGHT COLUMN: Chat Frame or Terminal Workspace */}
        <div id="main_workspace" className="lg:col-span-8 flex flex-col bg-sleek-card border border-sleek-border rounded-2xl shadow-2xl relative overflow-hidden h-[calc(100vh-140px)] min-h-[600px]">
          
          {/* Main workspace Tabs selector */}
          <div className="border-b border-sleek-border bg-sleek-sidebar p-1 flex items-center justify-between">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveTab("chat")}
                className={`px-4 py-2 text-xs font-bold tracking-wide uppercase transition rounded flex items-center gap-2 cursor-pointer ${
                  activeTab === "chat"
                    ? "bg-[#0f1115] text-[#e2e8f0] border-b-2 border-[#3b82f6]"
                    : "text-[#64748b] hover:text-[#e2e8f0]"
                }`}
              >
                <MessageSquare className="w-4 h-4 text-[#3b82f6]" />
                Визуальный Чат (Chat UI)
              </button>
              <button
                onClick={() => setActiveTab("terminal")}
                className={`px-4 py-2 text-xs font-bold tracking-wide uppercase transition rounded flex items-center gap-2 cursor-pointer ${
                  activeTab === "terminal"
                    ? "bg-[#0f1115] text-[#22c55e] border-b-2 border-emerald-500"
                    : "text-[#64748b] hover:text-[#e2e8f0]"
                }`}
              >
                <Terminal className="w-4 h-4 text-emerald-400" />
                Терминал Ядра (Go CLI Emulator)
              </button>
            </div>

            {/* Quick Helper indicators */}
            <div className="pr-3 text-[#64748b] font-mono text-[10px] hidden md:flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-blue-400" />
              <span>TLS Connection Layer: ACTIVE</span>
            </div>
          </div>

          {/* TAB CONTENT: VISUAL CHAT VIEW */}
          {activeTab === "chat" && (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              {!activeChat ? (
                // Workspace Empty State
                <div className="flex-1 flex flex-col justify-center items-center p-8 text-center max-w-md mx-auto">
                  <div className="w-16 h-16 bg-[#3b82f6]/10 border border-[#3b82f6]/20 text-[#3b82f6] rounded-full flex items-center justify-center mb-5">
                    <MessageSquare className="w-8 h-8" />
                  </div>
                  <h3 className="font-bold text-white text-lg tracking-normal mb-1 bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent font-sans">
                    Диалог не открыт
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed mb-6 font-normal">
                    Выберите кого-то из списка "Известные Узлы" слева или войдите в интерактивный режим в консоли введя команду <code>chat assistant@p2p.net</code>.
                  </p>
                  
                  <div className="w-full space-y-2">
                    <div className="text-[10px] font-bold text-[#64748b] uppercase tracking-widest text-left mb-3 pl-1">
                      Рекомендуемые авто-сервисы (AI):
                    </div>
                    <button
                      onClick={() => handleSelectNodeChat("assistant@p2p.net")}
                      className="w-full text-left p-3 rounded border border-sleek-border bg-sleek-bg hover:bg-sleek-sidebar transition flex items-center justify-between group cursor-pointer"
                    >
                      <div>
                        <div className="text-xs font-mono font-bold text-white">assistant@p2p.net</div>
                        <div className="text-[10px] text-blue-400">Встроенный умный помощник Ядра P2P</div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-white transition group-hover:translate-x-1" />
                    </button>
                    <button
                      onClick={() => handleSelectNodeChat("crypto-guard@p2p.net")}
                      className="w-full text-left p-3 rounded border border-sleek-border bg-sleek-bg hover:bg-sleek-sidebar transition flex items-center justify-between group cursor-pointer"
                    >
                      <div>
                        <div className="text-xs font-mono font-bold text-white">crypto-guard@p2p.net</div>
                        <div className="text-[10px] text-emerald-400">Сканер безопасности сети и кибер-аудитор</div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-white transition group-hover:translate-x-1" />
                    </button>
                  </div>
                </div>
              ) : (
                // Active chat section
                <div className="flex-1 flex flex-col h-full overflow-hidden">
                  
                  {/* Chat details bar */}
                  <div className="p-3 bg-[#0f1115]/50 border-b border-sleek-border flex justify-between items-center px-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-[#22c55e] animate-pulse-slow" />
                      <div>
                        <div className="text-xs font-semibold font-mono text-white">
                          {activeChat}
                        </div>
                        <div className="text-[10px] text-blue-400 font-medium font-sans">
                          Децентрализованный зашифрованный канал
                        </div>
                      </div>
                    </div>
                    
                    <button
                      onClick={() => postCLICommand("/exit")}
                      className="text-xs text-rose-400 hover:text-rose-300 font-bold px-3 py-1 bg-rose-500/15 border border-rose-500/20 rounded transition cursor-pointer"
                    >
                      Закрыть чат (/exit)
                    </button>
                  </div>

                  {/* Compaction Aggregation alert banner */}
                  <div className="bg-[#3b82f6]/10 text-blue-200 border-b border-[#3b82f6]/20 py-2 px-4 flex items-center gap-2.5 text-[11px] leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                    <span>
                      <strong>SMTP агрегация активна:</strong> Все отправленные строки аккумулируются в течение <strong>2 сек</strong> и высылаются единым интернет-пакетом <code>text/plain</code> с MIME-разделителем <code>\n---\n</code> для экономии запросов.
                    </span>
                  </div>

                  {/* Messaging Bubble history streams */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {currentChatHistory.length === 0 ? (
                      <div className="text-center p-12 text-slate-500 text-xs flex flex-col justify-center items-center h-full gap-2">
                        <Compass className="w-8 h-8 text-slate-700 animate-spin-slow" />
                        <span>Новый диалог. Напишите приветственное сообщение, чтобы положить начало обмену.</span>
                      </div>
                    ) : (
                      currentChatHistory.map((m) => {
                        const isSelf = m.from === config.email;
                        return (
                          <div
                            key={m.id}
                            className={`flex ${isSelf ? "justify-end" : "justify-start animate-fade-in"}`}
                          >
                            <div className={`max-w-[80%] rounded-xl p-3 shadow-md flex flex-col gap-1 ${
                              isSelf
                                ? "bg-[#3b82f6] text-white rounded-br-none"
                                : "bg-[#15181e] text-[#cbd5e1] rounded-bl-none border border-sleek-border"
                            }`}>
                              <p className="text-xs font-normal leading-relaxed whitespace-pre-wrap font-sans">
                                {m.body}
                              </p>
                              <span className="text-[9px] font-mono select-none flex items-center gap-1 self-end text-slate-400">
                                <Clock className="w-3 h-3" />
                                {m.timestamp}
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Suggested message prompts */}
                  <div className="p-2 border-t border-sleek-border bg-sleek-sidebar overflow-x-auto flex gap-2 no-scrollbar">
                    <span className="text-[9px] font-bold text-[#64748b] tracking-wider uppercase pl-2 flex items-center">
                      Запросы:
                    </span>
                    <button
                      type="button"
                      onClick={() => setChatInput("Привет! Как твои дела?")}
                      className="text-[10px] text-slate-300 bg-sleek-card hover:bg-sleek-bg transition px-2.5 py-1 border border-sleek-border rounded-full cursor-pointer whitespace-nowrap"
                    >
                      "Привет! Как дела?"
                    </button>
                    {activeChat === "assistant@p2p.net" && (
                      <>
                        <button
                          type="button"
                          onClick={() => setChatInput("Расскажи, как устроен P2P транспорт через Mail?")}
                          className="text-[10px] text-slate-300 bg-sleek-card hover:bg-sleek-bg transition px-2.5 py-1 border border-sleek-border rounded-full cursor-pointer whitespace-nowrap"
                        >
                          "Как устроен SMTP транспорт?"
                        </button>
                        <button
                          type="button"
                          onClick={() => setChatInput("Какие у меня сейчас известные узлы сети?")}
                          className="text-[10px] text-slate-300 bg-sleek-card hover:bg-sleek-bg transition px-2.5 py-1 border border-sleek-border rounded-full cursor-pointer whitespace-nowrap"
                        >
                          "Список узлов сети"
                        </button>
                      </>
                    )}
                    {activeChat === "crypto-guard@p2p.net" && (
                      <>
                        <button
                          type="button"
                          onClick={() => setChatInput("Проведи аудит безопасности моего P2P хоста.")}
                          className="text-[10px] text-slate-300 bg-sleek-card hover:bg-sleek-bg transition px-2.5 py-1 border border-sleek-border rounded-full cursor-pointer whitespace-nowrap"
                        >
                          "Аудит безопасности"
                        </button>
                        <button
                          type="button"
                          onClick={() => setChatInput("Чем IMAP IDLE безопаснее обычного опроса polling?")}
                          className="text-[10px] text-slate-300 bg-sleek-card hover:bg-sleek-bg transition px-2.5 py-1 border border-sleek-border rounded-full cursor-pointer whitespace-nowrap"
                        >
                          "Безопасность IMAP IDLE"
                        </button>
                      </>
                    )}
                  </div>

                  {/* Messaging prompt typing container */}
                  <form onSubmit={handleSendChatMessage} className="p-3 bg-[#0f1115]/60 border-t border-sleek-border flex gap-2 items-center">
                    <span className="text-[10px] font-mono text-[#64748b] select-none pl-1 shrink-0 hidden md:inline">
                      {activeChat.split("@")[0]}&gt;
                    </span>
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={daemonState.running ? "Наберите сообщение и нажмите Enter..." : "Запустите Core Daemon..."}
                      disabled={!daemonState.running}
                      className="flex-1 bg-[#0f1115] border border-sleek-border rounded px-4 py-2.5 text-xs text-white focus:outline-none focus:border-[#3b82f6] disabled:opacity-50 font-sans placeholder:text-slate-600"
                    />
                    <button
                      type="submit"
                      disabled={!daemonState.running || !chatInput.trim()}
                      className="bg-[#3b82f6] hover:bg-blue-600 disabled:opacity-50 p-2.5 rounded text-white transition flex items-center justify-center shrink-0 cursor-pointer"
                    >
                      <CornerDownLeft className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          {/* TAB CONTENT: TERMINAL GRAPHICAL LOG LOGS */}
          {activeTab === "terminal" && (
            <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#0f1115] font-mono text-xs">
              
              {/* Commands quick helper tip block and Log Filters */}
              <div className="p-3 bg-sleek-sidebar border-b border-sleek-border text-[10px] text-[#64748b] flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between px-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
                  <span className="flex items-center gap-1">
                    <HelpCircle className="w-3.5 h-3.5 text-slate-450" />
                    Экспресс команды:
                  </span>
                  <div className="flex gap-2">
                    <button onClick={() => setTerminalInput("status")} className="bg-sleek-card hover:bg-sleek-bg text-slate-300 font-semibold px-2 py-0.5 border border-sleek-border rounded cursor-pointer">
                      status
                    </button>
                    <button onClick={() => setTerminalInput("nodes")} className="bg-sleek-card hover:bg-sleek-bg text-slate-300 font-semibold px-2 py-0.5 border border-sleek-border rounded cursor-pointer">
                      nodes
                    </button>
                    <button onClick={() => setTerminalInput("chat assistant@p2p.net")} className="bg-sleek-card hover:bg-sleek-bg text-slate-300 font-semibold px-2 py-0.5 border border-sleek-border rounded cursor-pointer">
                      chat assistant@p2p.net
                    </button>
                    <button onClick={() => setTerminalInput("help")} className="bg-sleek-card hover:bg-sleek-bg text-slate-300 font-semibold px-2 py-0.5 border border-sleek-border rounded cursor-pointer">
                      help
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center border-t border-sleek-border/40 pt-2.5 md:border-t-0 md:pt-0">
                  <span className="flex items-center gap-1 text-[10px]">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
                    Фильтр трафика:
                  </span>
                  <div className="flex gap-1.5 text-[9px] font-mono">
                    <button
                      onClick={() => setLogFilter("all")}
                      className={`px-2 py-0.5 border rounded cursor-pointer font-bold transition ${
                        logFilter === "all"
                          ? "bg-[#3b82f6] text-white border-[#3b82f6]"
                          : "bg-sleek-card hover:bg-sleek-bg text-slate-400 border-sleek-border"
                      }`}
                    >
                      ALL ({logs.length})
                    </button>
                    <button
                      onClick={() => setLogFilter("info")}
                      className={`px-2 py-0.5 border rounded cursor-pointer font-bold transition ${
                        logFilter === "info"
                          ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                          : "bg-sleek-card hover:bg-sleek-bg text-[#64748b] border-sleek-border"
                      }`}
                    >
                      INFO ({logs.filter((l) => l.type === "info").length})
                    </button>
                    <button
                      onClick={() => setLogFilter("success")}
                      className={`px-2 py-0.5 border rounded cursor-pointer font-bold transition ${
                        logFilter === "success"
                          ? "bg-emerald-500/20 text-emerald-405 border-emerald-500/40"
                          : "bg-sleek-card hover:bg-sleek-bg text-[#64748b] border-sleek-border"
                      }`}
                    >
                      SUCCESS ({logs.filter((l) => l.type === "success").length})
                    </button>
                    <button
                      onClick={() => setLogFilter("error")}
                      className={`px-2 py-0.5 border rounded cursor-pointer font-bold transition ${
                        logFilter === "error"
                          ? "bg-rose-500/20 text-rose-455 border-rose-500/40"
                          : "bg-sleek-card hover:bg-sleek-bg text-[#64748b] border-sleek-border"
                      }`}
                    >
                      ERRORS ({logs.filter((l) => l.type === "error").length})
                    </button>
                    <button
                      onClick={() => setLogFilter("network")}
                      className={`px-2 py-0.5 border rounded cursor-pointer font-bold transition ${
                        logFilter === "network"
                          ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/40"
                          : "bg-sleek-card hover:bg-sleek-bg text-[#64748b] border-sleek-border"
                      }`}
                    >
                      NET ({logs.filter((l) => l.type === "network").length})
                    </button>
                  </div>
                </div>
              </div>

              {/* Terminal list history logs stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-1.5 scrollbar-thin scroll-smooth select-text select-allselection:bg-slate-820 font-mono leading-relaxed h-[calc(100vh-280px)]">
                <div className="text-slate-500 border-b border-sleek-border pb-2 mb-3 text-[10px] flex justify-between items-center">
                  <span>
                    P2P Mail Chat Client Terminal Core v1.0.0 (Go emulator). Evaluator active.
                    <br />
                    Log level: DEBUG. Standard IO bound to SSE socket.
                  </span>
                  {logFilter !== "all" && (
                    <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded animate-pulse">
                      Фокус на: {logFilter.toUpperCase()} (Показано {filteredLogs.length} из {logs.length})
                    </span>
                  )}
                </div>

                {filteredLogs.length === 0 ? (
                  <div className="text-slate-600 italic py-4">
                    {logs.length === 0 
                      ? "No activity logs recorded. Launch the daemon node."
                      : `No logs of type "${logFilter}" match the current active filter.`}
                  </div>
                ) : (
                  filteredLogs.map((log) => {
                    let typeColor = "text-slate-400";
                    let prefix = "📎";
                    switch (log.type) {
                      case "info":
                        typeColor = "text-blue-400";
                        prefix = "⚙️ [INFO] ";
                        break;
                      case "success":
                        typeColor = "text-emerald-400 font-semibold";
                        prefix = "✅ [SUCCESS]";
                        break;
                      case "error":
                        typeColor = "text-rose-400 font-bold";
                        prefix = "❌ [ERROR] ";
                        break;
                      case "input":
                        typeColor = "text-amber-300 font-medium";
                        prefix = "➡️ [USER]  ";
                        break;
                      case "network":
                        typeColor = "text-cyan-400";
                        prefix = "🌐 [NET]   ";
                        break;
                    }

                    return (
                      <div key={log.id} className="flex gap-2.5 leading-relaxed break-all select-all hover:bg-[#1a1d23]/35 py-0.5 rounded px-1 transition text-[11px]">
                        <span className="text-[#64748b] shrink-0 font-light select-none">
                          [{log.timestamp}]
                        </span>
                        <span className={`${typeColor} font-mono block`}>
                          <span className="font-semibold select-none mr-1 opacity-80">{prefix}</span>
                          {log.message}
                        </span>
                      </div>
                    );
                  })
                )}
                <div ref={terminalEndRef} />
              </div>

              {/* Prompt interpreter input bar */}
              <form onSubmit={handleSendTerminalCommand} className="p-3 bg-[#0f1115] border-t border-sleek-border flex items-center gap-2">
                <span className="text-[#22c55e] font-bold select-none pl-1 shrink-0">
                  {activeChat ? `${activeChat.split("@")[0]}>` : "p2p-mail>"}
                </span>
                <input
                  type="text"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={handleTerminalKeyDown}
                  placeholder='Введите команду (например "help", "status", "nodes") и нажмите Enter...'
                  className="flex-1 bg-transparent border-none outline-none ring-0 focus:ring-0 text-amber-300 font-mono text-xs w-full caret-[#3b82f6]"
                  autoFocus
                />
                <span className="text-[10px] text-[#64748b] bg-sleek-card border border-sleek-border px-2 py-1 rounded select-none uppercase tracking-widest leading-none">
                  Eval CLI
                </span>
              </form>
            </div>
          )}
        </div>
      </main>

      {/* Humble professional visual signature footer */}
      <footer className="py-2.5 text-center text-[10px] text-[#64748b] border-t border-sleek-border bg-sleek-footer mt-auto select-none">
        P2P Mail Chat client interface is powered by an asynchronous Node/Typescript server bridging real-time SSE stream telemetry. All rights reserved.
      </footer>
    </div>
  );
}
