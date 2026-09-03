"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

/* Web Speech API 在 lib.dom 里没有类型声明，这里按实际用到的字段声明最小接口，
   不为了一个按钮引第三方类型包。识别本身由系统/浏览器厂商完成，我们只拿文本。 */
type SpeechAlternative = { transcript: string };
type SpeechResult = { isFinal: boolean; length: number; [index: number]: SpeechAlternative };
type SpeechResultEvent = { results: { length: number; [index: number]: SpeechResult } };
type SpeechErrorEvent = { error: string };

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Chrome 和 Safari 目前都只暴露 webkit 前缀那一份。 */
function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const ERROR_NOTICE: Record<string, string> = {
  "not-allowed": "麦克风没有授权，去系统或浏览器设置里允许后再试。",
  "service-not-allowed": "这台设备的语音识别服务不可用，可以先用键盘上的听写键。",
  "audio-capture": "没有找到可用的麦克风。",
  network: "语音识别要联网，网络恢复后再试。",
};

/** 口述文本接到已有内容后面：只有英文数字结尾才补空格，中文直接连写。 */
function joinSpoken(base: string, spoken: string) {
  if (!spoken) return base;
  if (!base) return spoken;
  if (/\s$/.test(base)) return base + spoken;
  return /[A-Za-z0-9]$/.test(base) ? `${base} ${spoken}` : base + spoken;
}

export function VoiceInputButton({
  value,
  disabled,
  onChange,
  onNotice,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onNotice?: (notice: string) => void;
}) {
  // 构造函数只有在浏览器里才拿得到，首屏必须和服务端渲染一致，所以挂载后再决定显不显示。
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // 按下麦克风那一刻输入框里已有的内容，口述文本追加在它后面。
  const baseRef = useRef("");
  // iOS 上一次识别常常自己结束，重启后 results 会清零，已定稿的部分先攒在这里。
  const committedRef = useRef("");
  const wantListeningRef = useRef(false);
  const sessionStartRef = useRef(0);

  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    onNoticeRef.current = onNotice;
  });

  useEffect(() => {
    // 非安全上下文（http 访问）下构造函数在，start() 却必然被拒，不如不给这个入口。
    setSupported(Boolean(recognitionCtor()) && window.isSecureContext);
  }, []);

  const teardown = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognitionRef.current = null;
    recognition.abort();
  }, []);

  useEffect(() => teardown, [teardown]);

  const startSession = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    // 有的实现按增量下发、有的每次重发全量，每次都从头重建这一段最稳。
    let sessionFinal = "";

    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) final += text;
        else interim += text;
      }
      sessionFinal = final;
      onChangeRef.current(joinSpoken(baseRef.current, committedRef.current + final + interim));
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      if (event.error === "no-speech") {
        wantListeningRef.current = false;
        onNoticeRef.current?.("没有听到声音，已经停止听写。");
        return;
      }
      wantListeningRef.current = false;
      onNoticeRef.current?.(ERROR_NOTICE[event.error] ?? "语音识别没能启动，先用键盘输入吧。");
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      committedRef.current += sessionFinal;
      recognitionRef.current = null;
      // 一开口就结束多半是这台设备根本不支持连续识别，别再自动重启转圈。
      if (wantListeningRef.current && Date.now() - sessionStartRef.current > 400) {
        startSession();
        return;
      }
      if (wantListeningRef.current) onNoticeRef.current?.("这台设备的语音识别没能持续，先用键盘上的听写键。");
      wantListeningRef.current = false;
      setListening(false);
      onChangeRef.current(joinSpoken(baseRef.current, committedRef.current));
    };

    sessionStartRef.current = Date.now();
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // 上一次识别还没释放时重复 start 会抛，交给 onend 那条路重来即可。
      recognitionRef.current = null;
      wantListeningRef.current = false;
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    baseRef.current = valueRef.current;
    committedRef.current = "";
    wantListeningRef.current = true;
    setListening(true);
    onNoticeRef.current?.("");
    startSession();
  }, [startSession]);

  useEffect(() => {
    if (disabled && wantListeningRef.current) stop();
  }, [disabled, stop]);

  if (!supported) return null;

  return (
    <button
      className={`icon-button voice-button${listening ? " is-listening" : ""}`}
      type="button"
      disabled={disabled}
      onClick={() => (listening ? stop() : start())}
      aria-pressed={listening}
      aria-label={listening ? "停止语音输入" : "语音输入"}
      title={listening ? "停止语音输入" : "语音输入"}
    >
      <Mic size={21} aria-hidden="true" />
    </button>
  );
}
