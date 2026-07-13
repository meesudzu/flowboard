from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel, Column, JSON


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Board(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    # Board mode controls which UI surface the App renders:
    #   - "canvas"   (default) — the existing React Flow canvas with nodes/edges
    #   - "generate"           — the new image-generation mode with no nodes
    # Mode is immutable post-create in v1; converting requires delete+recreate.
    mode: str = "canvas"
    created_at: datetime = Field(default_factory=_utcnow)


class Node(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    short_id: str = Field(index=True)
    type: str
    x: float = 0.0
    y: float = 0.0
    w: float = 240.0
    h: float = 160.0
    data: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "idle"
    created_at: datetime = Field(default_factory=_utcnow)


class Edge(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    source_id: int = Field(foreign_key="node.id")
    target_id: int = Field(foreign_key="node.id")
    kind: str = "ref"
    # Per-edge variant pin: when the source node holds multiple variants
    # (`data.mediaIds`), this index selects WHICH variant feeds the
    # downstream as a reference. None = "fall back to the source's
    # active mediaId" (the natural single-variant case).
    #
    # Why per-edge instead of expanding all variants on the wire: each
    # variant of the same upstream produces a SEPARATE Flow API call
    # (Flow doesn't bind output[i] to input[i] when both are
    # multi-variant). Pinning lets the user say "use variant 2 for
    # downstream A, variant 3 for downstream B" with two clicks; the
    # edge UI surfaces the pinned index so the binding stays visible.
    source_variant_idx: Optional[int] = None


class Request(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    node_id: Optional[int] = Field(default=None, foreign_key="node.id", index=True)
    type: str
    params: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "queued"
    result: dict = Field(default_factory=dict, sa_column=Column(JSON))
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    finished_at: Optional[datetime] = None


class Asset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    # node_id is optional -- assets can arrive from TRPC before any node
    # binding (e.g. the user browses an old Flow project).
    node_id: Optional[int] = Field(default=None, foreign_key="node.id", index=True)
    kind: str  # image | video | thumbnail
    # Media id (the hex uuid from Google Flow). Unique so ingest can upsert.
    uuid_media_id: Optional[str] = Field(default=None, index=True, unique=True)
    # Latest captured signed GCS URL (expires -- refreshed when user reopens
    # Flow tab).
    url: Optional[str] = None
    local_path: Optional[str] = None
    mime: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class MediaProjectMapping(SQLModel, table=True):
    """Cross-project media re-upload cache.

    Flow scopes mediaIds to the project they were uploaded in -- a
    ref_media_id from project A is unknown to project B even though we
    have the bytes cached locally. When a dispatch needs to reference
    media from another project (e.g. a cross-board Reference reused on
    a different board), we re-upload the bytes under the target project
    and record the (original, project) → project-local mapping here so
    subsequent dispatches skip the upload round-trip.

    Each row says: "bytes of `original_media_id` are also available
    under `project_id` as `project_local_media_id`". Unique on
    (original_media_id, project_id) -- composite index in __table_args__.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    original_media_id: str = Field(index=True)
    project_id: str = Field(index=True)
    project_local_media_id: str
    created_at: datetime = Field(default_factory=_utcnow)
    __table_args__ = (
        UniqueConstraint(
            "original_media_id", "project_id",
            name="uq_media_project_mapping",
        ),
    )


class Reference(SQLModel, table=True):
    """User-curated saved media for cross-board reuse.

    Distinct from Asset (auto-managed cache index). Each Reference
    points at one media_id and snapshots enough metadata to spawn a
    brand-new visual_asset node in any board without re-vision or
    re-upload.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True, unique=True)
    url: Optional[str] = None
    label: str = ""
    kind: str  # "image" | "character" | "visual_asset" | "storyboard_shot"
    ai_brief: Optional[str] = None
    aspect_ratio: Optional[str] = None
    tags: list = Field(default_factory=list, sa_column=Column(JSON))
    pinned: bool = False
    position: int = 0
    source_board_id: Optional[int] = Field(default=None, foreign_key="board.id", index=True)
    source_node_short_id: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class ChatMessage(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    role: str  # user | assistant | system
    content: str
    mentions: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_utcnow)


class Plan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    spec: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "draft"  # draft | approved | running | done | failed
    created_at: datetime = Field(default_factory=_utcnow)


class PlanRevision(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    plan_id: int = Field(foreign_key="plan.id", index=True)
    rev_no: int
    spec: dict = Field(default_factory=dict, sa_column=Column(JSON))
    edits: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_utcnow)


class PipelineRun(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    plan_id: int = Field(foreign_key="plan.id", index=True)
    status: str = "pending"  # pending | running | done | failed
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None


#: The default prompt template shown on every new generation-mode project.
#: Module-level so tests can import + assert against it without parsing
#: the SQLModel field default. Hoisted above the GenerationConfig class
#: so the ``prompt: str = DEFAULT_GENERATION_PROMPT`` field default can
#: reference it at class-definition time.
DEFAULT_GENERATION_PROMPT = (
    "Giữ chính xác thiết kế, màu sắc, chất liệu, logo, bao bì và các chi tiết nhận diện của sản phẩm từ ảnh gốc.\n"
    "Bố cục: Người mẫu Đứng thẳng, hai tay khoanh nhẹ trước ngực tạo dáng tự nhiên, thể hiện sự tự tin và phong thái chuyên nghiệp. Ánh mắt nhìn thẳng vào ống kính với biểu cảm tự chủ và cuốn hút.\n"
    "[Ảnh tham chiếu]: Ảnh đầu là sản phẩm. Ảnh sau là chân dung người mẫu được sử dụng làm hình ảnh tham khảo chính xác về bố cục, phong cách và cảm xúc.\n"
    "[Lưu ý] có độ phân giải 4K, chi tiết cao, chân thực như ảnh chụp, giữ nguyên cấu trúc và chất liệu sản phẩm."
)


class GenerationConfig(SQLModel, table=True):
    """1:1 with Board for projects in ``mode="generate"`` mode.

    Stores the per-board generation configuration: which model image is
    being used, the shared prompt text, aspect ratio, and image model
    choice. One row per board; inserting twice is a programming error
    (use the existing row).
    """
    board_id: int = Field(primary_key=True, foreign_key="board.id")
    # The Flow-issued media id of the uploaded model image, set via
    # POST /api/boards/{id}/generation-mode/model. None until the
    # first upload completes.
    model_media_id: Optional[str] = None
    # Free-form user prompt describing background / pose / mood. Sent
    # to Flow as part of the structuredPrompt for every per-product
    # generation. New projects are seeded with DEFAULT_GENERATION_PROMPT
    # (a Vietnamese lookbook template) so the textarea isn't empty --
    # the user can overwrite via PATCH /config at any time.
    prompt: str = DEFAULT_GENERATION_PROMPT
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT"
    image_model: str = "NANO_BANANA_PRO"
    updated_at: datetime = Field(default_factory=_utcnow)


class GenerationProduct(SQLModel, table=True):
    """A product image uploaded into a generation-mode project.

    Each row carries the Flow media id of the product image and a stable
    ``position`` integer (assigned at upload time, monotonically
    increasing) so the gallery renders in upload order without ORDER BY
    RANDOM() or relying on ``created_at`` ties.

    ``prompt_override`` is a per-product override of the board's
    shared config prompt. When non-empty, the worker uses it INSTEAD
    of ``GenerationConfig.prompt`` for this product only; other
    products in the same batch still get the shared prompt. An
    empty string means "use the shared prompt". This lets the
    user tweak the prompt for one product (e.g. a different pose
    for a particular garment) without changing the whole batch.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    media_id: str
    position: int = 0
    label: str = ""
    # Per-product prompt override. See class docstring. Empty by
    # default so existing rows keep using the shared config prompt.
    prompt_override: str = ""
    uploaded_at: datetime = Field(default_factory=_utcnow)


class GenerationResult(SQLModel, table=True):
    """The output of one per-product generation run.

    A product may have multiple GenerationResult rows over time (every
    "regenerate" appends a new one). The frontend reads the *latest*
    row per product when rendering the gallery, ordered by created_at DESC.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    product_id: int = Field(foreign_key="generationproduct.id", index=True)
    # The Flow media id of the generated output image. None while pending/
    # running; filled in by the worker on success. Reset when the user
    # hits "regenerate" so stale outputs don't render next to new ones.
    output_media_id: Optional[str] = None
    # Exact prompt string sent to Flow for this run -- logged so the user
    # can audit what was dispatched (important when LLM auto-prompt is
    # wired in later).
    prompt_used: str = ""
    # pending | queued | running | done | failed | canceled -- mirrors the
    # Request.status vocabulary so a single front-end filter can apply.
    status: str = "pending"
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    finished_at: Optional[datetime] = None


class BoardFlowProject(SQLModel, table=True):
    """1:1 link between a local board and a Google Flow project_id.

    Kept as a separate table so we don't have to migrate the Board schema.
    Paygate tier is loaded realtime from the extension via /api/auth/me,
    not persisted here -- the binding is purely about project identity.
    """
    board_id: int = Field(primary_key=True, foreign_key="board.id")
    flow_project_id: str
    created_at: datetime = Field(default_factory=_utcnow)
