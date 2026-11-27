import { GUIDE_VIDEO_SRC, GUIDE_POSTER_SRC } from "./bera-guide-assets";

// The living face shared by the Bera Guide and Agent Bera itself:
// Jeeves' looping avatar video inside the spinning gradient ring.
// States: idle (slow ring), talking (gentle pulse), working (fast
// ring + a typing-dots pill — the "I am busy right now" signal).
export function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-label="working">
      {[0, 1, 2].map(i => (
        <span key={i} className="agent-typing-dot" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}

export default function AgentFace({ size = 56, working = false, talking = false }: { size?: number; working?: boolean; talking?: boolean }) {
  return (
    <div
      className="relative flex items-center justify-center shrink-0"
      style={{ width: size, height: size, ...(talking ? { animation: "guideTalk 0.45s ease-in-out infinite alternate" } : {}) }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: "conic-gradient(from 0deg, #00d4ff, #7c3aed, #00d4ff)",
          animation: working ? "agentSpin 1.2s linear infinite" : "agentSpin 4s linear infinite",
          padding: "2px",
        }}
      />
      <div className="absolute inset-[2px] rounded-full overflow-hidden bg-[#0a0f1e]">
        <video
          src={GUIDE_VIDEO_SRC}
          poster={GUIDE_POSTER_SRC}
          autoPlay
          loop
          muted
          playsInline
          draggable={false}
          className="h-full w-full object-cover"
        />
      </div>
      {working && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-center rounded-full border border-primary/40 bg-[#080e1d]/95 px-1.5 py-0.5">
          <TypingDots />
        </span>
      )}
      <style>{`
        @keyframes agentSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes guideTalk { from { transform: scale(1); } to { transform: scale(1.06); } }
        .agent-typing-dot { width: 4px; height: 4px; border-radius: 9999px; background: #00d4ff; display: inline-block; animation: agentTyping 1s ease-in-out infinite; }
        @keyframes agentTyping { 0%, 60%, 100% { transform: translateY(0); opacity: 0.45; } 30% { transform: translateY(-3px); opacity: 1; } }
      `}</style>
    </div>
  );
}
