// Source of truth for the human-readable explanation of every node type
// that lives on a board. Surfaced via the hover tooltip on:
//   1. Every node card on the canvas (NodeCard)
//   2. Every chip in the "+" add-node palette (AddNodePalette)
//
// Keep the `description` to one short sentence — the tooltip is narrow
// and users want a quick read. Use `tip` for the "how to use" line.
// Both are intentionally in Vietnamese so they match the rest of the UI
// copy. Add a new entry here when a new NodeType is introduced in
// `frontend/src/api/client.ts`.

import type { NodeType } from "../store/board";

export interface NodeDescription {
  /** Icon glyph — keeps the palette in sync with the rendered card. */
  icon: string;
  /** Human label, e.g. for screen readers. */
  label: string;
  /** One-sentence "what is this node" — answers "ô này làm gì?". */
  description: string;
  /** One-sentence "how do I use it" — answers "tác dụng / cách dùng?". */
  tip: string;
}

export const NODE_DESCRIPTIONS: Record<NodeType, NodeDescription> = {
  character: {
    icon: "◎",
    label: "Nhân vật",
    description:
      "Ô neo giữ danh tính của một người ổn định xuyên suốt mọi ảnh phía sau.",
    tip: "Tạo bằng mẫu giới tính + quốc tịch (VN / KR / JP / CN / TH / US / FR) hoặc tải ảnh chân dung lên. Luôn được neo về ảnh chụp thẳng, miệng khép, biểu cảm trung tính — Veo i2v không giữ được danh tính nếu ảnh gốc cười. Nối ô này vào một ô Ảnh làm tham chiếu.",
  },
  image: {
    icon: "▣",
    label: "Ảnh",
    description:
      "Ảnh tĩnh được tạo ra, lấy mọi media của các ô phía trên làm tham chiếu cho Flow (IMAGE_INPUT_TYPE_REFERENCE).",
    tip: "Kết nối bao nhiêu nhân vật / sản phẩm / ảnh khác phía trên cũng được. Để trống prompt để LLM tự soạn prompt khác tư thế từ mô tả phía trên (1–4 biến thể mỗi lượt). Tỉ lệ mặc định kế thừa từ ô phía trên.",
  },
  Storyboard: {
    icon: "▦",
    label: "Storyboard",
    description:
      "1–8 cảnh kể chuyện gói trong một ô — LLM lập kế hoạch sẽ dựng cây liên tục (gốc + nối tiếp) và chạy song song.",
    tip: "Dùng cho chuỗi cốt truyện (unbox → thử đồ → đi chơi, chuỗi cảnh, danh sách cảnh quay thương mại điện tử). Chọn 2×2 / 2×3 / 2×4 — hàng × cột thực tế sẽ đảo cho bố cục dọc. Tham chiếu từ các cạnh phía trên áp dụng cho mọi ô; cảnh lỗi giữ trạng thái 'một phần' và có thể thử lại từng ô.",
  },
  video: {
    icon: "▶",
    label: "Video",
    description:
      "Clip ảnh-thành-video tạo qua Veo — i2v đa nguồn: ảnh phía trên có 4 biến thể sẽ tạo 4 clip trong một lượt.",
    tip: "Kết nối một ô Ảnh phía trên, rồi chọn Tĩnh (khung hình khóa, an toàn cho thương mại điện tử) hoặc Động (dolly / lia nhẹ). Tích các biến thể bạn muốn — có nút Tất cả / Bỏ chọn — và bộ điều phối sẽ gửi một yêu cầu Veo cho mỗi ảnh gốc. Chuyển động được mã hoá theo mốc thời gian để mô hình thực hiện chuỗi động tác tạp chí trong clip 8 giây.",
  },
  visual_asset: {
    icon: "◇",
    label: "Sản phẩm",
    description:
      "Ô neo cho sản phẩm, trang phục hoặc đồ vật cần xuất hiện nhất quán trong các bối cảnh.",
    tip: "Tải lên từ file / URL, hoặc tạo từ prompt. Nút Tinh chỉnh ngay trong ô dùng edit_image của Flow để lặp lại trên cùng BASE_IMAGE mà không mất ảnh gốc. Khi lượt tạo phía dưới chạy, ô này sẽ có aiBrief mô tả nội dung ảnh — mô tả này sẽ được ghép vào mọi prompt tự động phía dưới.",
  },
  prompt: {
    icon: "✦",
    label: "Prompt",
    description:
      "Định hướng phong cách tự do (tâm trạng, tông màu, ánh sáng, gợi ý copy) cung cấp cho prompt tự động phía dưới khi prompt của ô được kết nối để trống.",
    tip: "Bấm đúp để sửa. Gõ định hướng điện ảnh (ví dụ: \"tông ấm, tâm trạng tạp chí, DOF nông\") thay vì mô tả cụ thể — nó sẽ được ghép với mô tả phía trên để soạn prompt cuối. Nối vào một ô Ảnh hoặc Video.",
  },
  note: {
    icon: "✎",
    label: "Ghi chú",
    description:
      "Vùng ghi chú dạng văn bản — TODO, nhãn, ý tưởng cảnh. Không có hành vi tạo ảnh, không trạng thái, không media.",
    tip: "Bấm đúp để sửa. Ghi chú dán đơn thuần cho bảng vẽ: dùng để đánh dấu TODO, ghi nhãn cảnh, hoặc để lại gợi ý cho chính bạn. Không gửi gì xuống phía dưới.",
  },
};

// Single-source-of-truth view: just the label for each node type.
// Derived from NODE_DESCRIPTIONS so the chip bar, tooltip, and
// canvas card title can never drift apart again. Used by the
// Zustand store when creating new nodes — see board.ts.
export const TYPE_TITLE: Record<NodeType, string> = Object.fromEntries(
  (Object.entries(NODE_DESCRIPTIONS) as [NodeType, NodeDescription][]).map(
    ([k, v]) => [k, v.label],
  ),
) as Record<NodeType, string>;

/**
 * Lookup helper that falls back to a "this is a node" placeholder so
 * unknown types never crash the tooltip render. Defensive — the type
 * system already prevents this at compile time, but the Tooltip lives
 * in many places and a runtime fallback is cheap.
 */
export function describeNode(type: string): NodeDescription {
  const known = NODE_DESCRIPTIONS[type as NodeType];
  if (known) return known;
  return {
    icon: "□",
    label: type,
    description: "Một ô trên canvas.",
    tip: "Di chuột để xem ô này làm gì.",
  };
}
