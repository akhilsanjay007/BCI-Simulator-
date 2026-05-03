import { useState, useEffect, useRef } from "react";

interface DecoderPacket {
  timestamp_ms: number;
  predicted_intent: "left" | "right" | "up" | "down";
  confidence: number;
  latency_ms: number;
  accuracy: number;
  /** Normalized [0,1] from server-integrated 2D cursor */
  cursor_x?: number;
  cursor_y?: number;
}

function App() {
  const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
  const [decoderData, setDecoderData] = useState<DecoderPacket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Connect to decoder WebSocket
    const ws = new WebSocket("ws://localhost:8000/ws/decoder");
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      console.log("✅ Connected to BCI Decoder");
    };

    ws.onmessage = (event) => {
      try {
        const data: DecoderPacket = JSON.parse(event.data);
        setDecoderData(data);
      } catch (error) {
        console.error("Error parsing decoder data:", error);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      console.log("❌ Disconnected from BCI Decoder");
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setStatus("disconnected");
    };

    // Cleanup on unmount
    return () => {
      ws.close();
    };
  }, []);

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "left": return "text-blue-400";
      case "right": return "text-red-400";
      case "up": return "text-green-400";
      case "down": return "text-yellow-400";
      default: return "text-neutral-400";
    }
  };

  return (
    <div className="min-h-screen bg-neuralink-bg p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-neuralink-accent rounded-full flex items-center justify-center text-black font-bold text-2xl">
              N
            </div>
            <h1 className="text-4xl font-bold tracking-tighter">Neuralink BCI Dashboard</h1>
          </div>

          <div className={`px-6 py-2.5 rounded-full text-sm font-medium flex items-center gap-3 border
            ${status === "connected" 
              ? "bg-green-500/10 border-green-500/30 text-green-400" 
              : "bg-red-500/10 border-red-500/30 text-red-400"}`}>
            <div className={`w-3 h-3 rounded-full ${status === "connected" ? "bg-green-400 animate-pulse" : "bg-red-400"}`}></div>
            {status.toUpperCase()}
          </div>
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Main Cursor Area */}
          <div className="col-span-8 bg-neutral-900/70 backdrop-blur-xl rounded-3xl p-8 border border-neutral-800">
            <h2 className="text-2xl font-semibold mb-6">Cursor Control Demo</h2>
            <div className="h-[460px] bg-black rounded-2xl border border-neutral-800 relative overflow-hidden">
              <div className="absolute inset-0 opacity-30 pointer-events-none"
                style={{
                  backgroundImage: `
                    linear-gradient(to right, rgb(38 38 38) 1px, transparent 1px),
                    linear-gradient(to bottom, rgb(38 38 38) 1px, transparent 1px)
                  `,
                  backgroundSize: "40px 40px",
                }}
              />
              <div className="absolute left-1/2 top-1/2 w-2 h-2 -ml-1 -mt-1 rounded-full bg-neutral-600" aria-hidden />
              {decoderData && (
                <div
                  className="absolute w-4 h-4 rounded-full bg-neuralink-accent shadow-[0_0_20px_rgba(0,255,170,0.5)] border-2 border-white/90 z-10 transition-all duration-75 ease-linear"
                  style={{
                    left: `${(decoderData.cursor_x ?? 0.5) * 100}%`,
                    top: `${(decoderData.cursor_y ?? 0.5) * 100}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                  title="Decoded cursor"
                />
              )}
              {!decoderData && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-neutral-500 font-mono text-center text-sm">
                    Waiting for decoder stream…
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="col-span-4 space-y-6">
            {/* Current Intent */}
            <div className="bg-neutral-900/70 backdrop-blur-xl rounded-3xl p-8 border border-neutral-800">
              <h2 className="text-2xl font-semibold mb-6">Predicted Intent</h2>
              <div className={`text-8xl font-bold text-center tracking-tighter transition-all duration-300 ${decoderData ? getIntentColor(decoderData.predicted_intent) : "text-neutral-400"}`}>
                {decoderData ? decoderData.predicted_intent.toUpperCase() : "—"}
              </div>
            </div>

            {/* Metrics */}
            <div className="bg-neutral-900/70 backdrop-blur-xl rounded-3xl p-8 border border-neutral-800">
              <h2 className="text-2xl font-semibold mb-6">Decoder Metrics</h2>
              <div className="space-y-6 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">Latency</span>
                  <span className="font-mono text-lg font-medium text-green-400">
                    {decoderData ? `${decoderData.latency_ms.toFixed(1)} ms` : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">Confidence</span>
                  <span className="font-mono text-lg font-medium">
                    {decoderData ? `${(decoderData.confidence * 100).toFixed(0)}%` : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">Accuracy</span>
                  <span className="font-mono text-lg font-medium text-green-400">
                    {decoderData ? `${(decoderData.accuracy * 100).toFixed(1)}%` : "—"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;