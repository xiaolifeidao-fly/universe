import { useCallback, useRef } from "react";
import type { CompositionEvent as ReactCompositionEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

/** compositionend 之后浏览器仍可能补发一次 Enter keydown，这段时间内的回车一律算选词。 */
const COMPOSITION_TAIL_MS = 80;

/**
 * 中文/日文输入法用回车确认候选词时，浏览器照样会派发 Enter keydown。
 * 只看 event.key === "Enter" 会把选词当成发送，必须结合合成态一起判断。
 */
export function isComposingKeyEvent(event: ReactKeyboardEvent<HTMLElement>): boolean {
  const native = event.nativeEvent as KeyboardEvent | undefined;
  return Boolean(native?.isComposing) || native?.keyCode === 229;
}

export interface ImeCompositionGuard {
  /** 挂到输入框（或其容器）上，用来跟踪合成态。 */
  compositionProps: {
    onCompositionStart: (event: ReactCompositionEvent<HTMLElement>) => void;
    onCompositionEnd: (event: ReactCompositionEvent<HTMLElement>) => void;
  };
  /** 回车是否只是输入法在选词——是就别发送。 */
  isComposingEnter: (event: ReactKeyboardEvent<HTMLElement>) => boolean;
}

/**
 * 输入法回车保护：Safari 等浏览器在选词时会先抛 compositionend 再抛 keydown，
 * 此时 nativeEvent.isComposing 已经是 false，只能靠自己记的合成态兜底。
 */
export function useImeCompositionGuard(): ImeCompositionGuard {
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    endedAtRef.current = Date.now();
  }, []);

  const isComposingEnter = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    return isComposingKeyEvent(event)
      || composingRef.current
      || Date.now() - endedAtRef.current < COMPOSITION_TAIL_MS;
  }, []);

  return { compositionProps: { onCompositionStart, onCompositionEnd }, isComposingEnter };
}
