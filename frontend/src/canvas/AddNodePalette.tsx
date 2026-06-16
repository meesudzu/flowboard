import { useReactFlow } from "@xyflow/react";
import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";
import { NodeTooltip } from "./NodeTooltip";

// Build chips từ description source-of-truth để palette's label + icon
// luôn đồng bộ với node card và tooltip render. Sắp theo label để có
// thứ tự ổn định — thứ tự hand-curated trước đây cũng là NodeType
// declaration order, nhưng explicit ordering giúp palette testable.
import { NODE_DESCRIPTIONS } from "./nodeDescriptions";

interface Chip {
  type: NodeType;
}

const CHIP_ORDER: NodeType[] = [
  "character",
  "image",
  "Storyboard",
  "video",
  "visual_asset",
  "prompt",
  "note",
];

const CHIPS: Chip[] = CHIP_ORDER.map((type) => ({ type }));

export function AddNodePalette() {
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  return (
    <div className="add-node-palette" aria-label="Thêm ô">
      <span className="add-node-plus" aria-hidden="true">+</span>
      {CHIPS.map((chip) => {
        // Re-resolve mỗi render — cheap (object lookup) và giữ
        // chip đồng bộ với description source-of-truth nếu entry
        // NODE_DESCRIPTIONS được hot-reload trong dev.
        const meta = NODE_DESCRIPTIONS[chip.type];
        return (
          <NodeTooltip key={chip.type} type={chip.type}>
            <button
              className="add-node-chip"
              aria-label={`Thêm ô ${meta.label} — ${meta.description}`}
              onClick={() => handleAdd(chip.type)}
            >
              <span aria-hidden="true">{meta.icon}</span>
              {meta.label}
            </button>
          </NodeTooltip>
        );
      })}
    </div>
  );
}
