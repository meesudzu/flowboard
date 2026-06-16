import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { describeNode, type NodeDescription } from "./nodeDescriptions";

/**
 * Hover-tooltip giải thích ô đó là gì và cách dùng.
 *
 * Implementation: wrapper <span> bao bọc children. Events được gắn
 * bằng `addEventListener` native thông qua ref — không qua React props
 * — vì React's onMouseEnter trên một wrapper đôi khi không fire khi
 * mouse đi vào child (đặc biệt với children có onClick của riêng nó).
 *
 * Đã từng dùng `display: contents` trên wrapper → events không dispatch
 * được (wrapper không có box). Sau đó đổi sang `display: inline-flex`
 * → vẫn có trường hợp không fire. Cách hiện tại dùng native event listener
 * trên chính DOM element qua ref nên robust hơn.
 *
 * Hai nơi dùng:
 *   - <NodeCard/> — bọc biểu tượng ⓘ "info" trên header của ô.
 *   - <AddNodePalette/> — bọc mỗi chip "+" để user học sự khác nhau giữa
 *     Image / Video / Storyboard / Visual asset trước khi thêm.
 */

const TOOLTIP_W = 320;
const TOOLTIP_H = 160;
const VIEW_MARGIN = 8;
const OPEN_DELAY_MS = 200;
const CLOSE_DELAY_MS = 100;

export function NodeTooltip({
  type,
  children,
}: {
  type: string;
  children: ReactNode;
}) {
  const desc = describeNode(type);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    arrowLeft: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(false);

  // Keep openRef in sync with state.
  openRef.current = open;

  function clearTimers() {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function showTooltip() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current !== null) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }

  function hideTooltip() {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }

  function measure() {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
    let top = rect.bottom + 6;
    let arrowLeft = TOOLTIP_W / 2;

    const minLeft = VIEW_MARGIN;
    const maxLeft = Math.max(VIEW_MARGIN, window.innerWidth - TOOLTIP_W - VIEW_MARGIN);
    if (left < minLeft) {
      arrowLeft = arrowLeft + (minLeft - left);
      left = minLeft;
    } else if (left > maxLeft) {
      arrowLeft = arrowLeft - (left - maxLeft);
      left = maxLeft;
    }

    const minTop = VIEW_MARGIN;
    const maxTop = Math.max(VIEW_MARGIN, window.innerHeight - TOOLTIP_H - VIEW_MARGIN);
    if (top < minTop) top = minTop;
    if (top > maxTop) top = maxTop;

    setCoords({ left, top, arrowLeft });
  }

  // Native event listeners — không qua React's synthetic event system.
  // Gắn trực tiếp lên wrapper span element. Mouseenter/leave là
  // non-bubbling, nhưng khi gắn lên wrapper (thay vì React props), browser
  // sẽ dispatch chính xác khi mouse vào/ra khỏi wrapper box.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    // mouseenter/leave: không bubble, fire khi mouse vào/ra khỏi element
    el.addEventListener("mouseenter", showTooltip);
    el.addEventListener("mouseleave", hideTooltip);
    // focusin/out: focus event từ bất kỳ child nào cũng bubble lên đây
    el.addEventListener("focusin", showTooltip);
    el.addEventListener("focusout", hideTooltip);

    return () => {
      el.removeEventListener("mouseenter", showTooltip);
      el.removeEventListener("mouseleave", hideTooltip);
      el.removeEventListener("focusin", showTooltip);
      el.removeEventListener("focusout", hideTooltip);
    };
  }, []);

  // Position follow mỗi frame khi đang mở.
  useEffect(() => {
    if (!open) return;
    let rafId = 0;
    const tick = () => {
      if (!openRef.current) return;
      measure();
      rafId = requestAnimationFrame(tick);
    };
    // Measure ngay lập tức để set coords, rồi lặp lại mỗi frame.
    measure();
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open]);

  useEffect(() => {
    return () => clearTimers();
  }, []);

  const { icon, label } = desc as NodeDescription & { icon: string; label: string };

  return (
    <span
      ref={wrapperRef}
      className="node-tooltip-trigger"
    >
      {children}
      {open && coords && createPortal(
        <div
          className="node-tooltip node-tooltip--bottom"
          style={{ left: coords.left, top: coords.top }}
          role="tooltip"
        >
          <div
            className="node-tooltip__arrow"
            style={coords ? { left: `${coords.arrowLeft}px` } : undefined}
          />
          <div className="node-tooltip__head">
            <span className="node-tooltip__icon" aria-hidden="true">
              {icon}
            </span>
            <span className="node-tooltip__label">{label}</span>
            <span className="node-tooltip__type-pill">loại ô</span>
          </div>
          <p className="node-tooltip__desc">{desc.description}</p>
          <p className="node-tooltip__tip">
            <span className="node-tooltip__tip-label">Cách dùng</span>
            {desc.tip}
          </p>
        </div>,
        document.body
      )}
    </span>
  );
}
