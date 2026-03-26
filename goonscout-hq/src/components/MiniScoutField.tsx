import * as React from "react";

type MiniButtonAsset = {
  id: string;
  kind: "button" | "icon-button" | "button-slider";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  icon?: string;
  tag?: string;
};

type BoxSize = { width: number; height: number };
type BoxBounds = { left: number; top: number; width: number; height: number };

type MiniScoutFieldProps = {
  payloadObject: unknown;
  fieldImageUrl: string;
  className?: string;
};

const EXCLUDED_ACTIONS = new Set(["undo", "redo", "submit", "reset"]);
const EXCLUDED_BUTTON_TEXT = new Set(["undo", "redo", "submit", "reset"]);

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return Array.isArray(parsed) ? parsed : null;
  }
  return null;
}

function toNormalizedKind(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (raw === "icon-button" || raw === "icon") {
    return "icon-button";
  }

  if (raw === "button-slider") {
    return "button-slider";
  }

  if (raw === "submit" || raw === "reset" || raw === "undo" || raw === "redo") {
    return "button";
  }

  return raw;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function clampPositionScale(value: number): number {
  return Math.max(-100, Math.min(100, value));
}

function clampSizeScale(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function toPercentFromScale(value: number): number {
  return ((value + 100) / 200) * 100;
}

function getContainedBounds(containerSize: BoxSize, contentSize: BoxSize): BoxBounds {
  const { width: cw, height: ch } = containerSize;
  const { width: iw, height: ih } = contentSize;

  if (cw <= 0 || ch <= 0 || iw <= 0 || ih <= 0) {
    return { left: 0, top: 0, width: Math.max(0, cw), height: Math.max(0, ch) };
  }

  const scale = Math.min(cw / iw, ch / ih);
  const width = iw * scale;
  const height = ih * scale;

  return {
    left: (cw - width) / 2,
    top: (ch - height) / 2,
    width,
    height,
  };
}

function normalizeCompactPayloadItems(payloadEntries: unknown[]): Record<string, unknown>[] {
  return payloadEntries.reduce<Record<string, unknown>[]>((acc, entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return acc;
    }

    const sourceEntry = entry as Record<string, unknown>;
    const keys = Object.keys(sourceEntry);
    if (keys.length !== 1) {
      return acc;
    }

    const sourceKind = keys[0];
    const sourceValue = sourceEntry[sourceKind];
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
      return acc;
    }

    const source = sourceValue as Record<string, unknown>;

    const left = toFiniteNumber(source.x1);
    const right = toFiniteNumber(source.x2);
    const top = toFiniteNumber(source.y1);
    const bottom = toFiniteNumber(source.y2);
    const hasBounds = left !== null && right !== null && top !== null && bottom !== null;

    const x = toFiniteNumber(source.x) ?? (hasBounds ? ((left as number) + (right as number)) / 2 : null);
    const y = toFiniteNumber(source.y) ?? (hasBounds ? ((top as number) + (bottom as number)) / 2 : null);
    const width = toFiniteNumber(source.width) ?? (hasBounds ? Math.abs((right as number) - (left as number)) : null);
    const height = toFiniteNumber(source.height) ?? (hasBounds ? Math.abs((top as number) - (bottom as number)) : null);

    if (x === null || y === null || width === null || height === null) {
      return acc;
    }

    const resolvedKind = toNormalizedKind(sourceKind);

    acc.push({
      ...source,
      id:
        typeof source.id === "string" && source.id.trim().length > 0
          ? source.id.trim()
          : `${resolvedKind}-${index}`,
      type: resolvedKind,
      kind: resolvedKind,
      x,
      y,
      width,
      height,
      text:
        typeof source.text === "string"
          ? source.text
          : typeof source.label === "string"
            ? source.label
            : undefined,
      icon:
        typeof source.icon === "string"
          ? source.icon
          : typeof source.iconName === "string"
            ? source.iconName
            : undefined,
    });

    return acc;
  }, []);
}

function getPayloadItems(payloadObject: unknown): Record<string, unknown>[] {
  const parsedRoot = typeof payloadObject === "string" ? parseJsonObject(payloadObject) : payloadObject;

  if (Array.isArray(parsedRoot)) {
    return normalizeCompactPayloadItems(parsedRoot);
  }

  const source = toRecord(parsedRoot);
  if (!source) {
    return [];
  }

  const payloadArray = toArray(source.payload);
  if (payloadArray) {
    return normalizeCompactPayloadItems(payloadArray);
  }

  const nestedPayloadObject = toRecord(source.payload);
  if (nestedPayloadObject) {
    const nestedPayloadArray = toArray(nestedPayloadObject.payload);
    if (nestedPayloadArray) {
      return normalizeCompactPayloadItems(nestedPayloadArray);
    }
  }

  const editorStateValue =
    typeof source.editorState === "string" ? parseJsonObject(source.editorState) : source.editorState;
  const editorState = toRecord(editorStateValue);
  const editorItems = toArray(editorState?.items);

  if (editorItems) {
    return editorItems
      .map((value, index) => {
        const item = toRecord(value);
        if (!item) {
          return null;
        }

        const x = toFiniteNumber(item.x);
        const y = toFiniteNumber(item.y);
        const width = toFiniteNumber(item.width);
        const height = toFiniteNumber(item.height);
        if (x === null || y === null || width === null || height === null) {
          return null;
        }

        const normalizedKind = toNormalizedKind(item.type ?? item.kind);
        const label = typeof item.label === "string" ? item.label : undefined;

        return {
          ...item,
          id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : `${normalizedKind}-${index}`,
          type: normalizedKind,
          kind: normalizedKind,
          x,
          y,
          width,
          height,
          text: typeof item.text === "string" ? item.text : label,
          icon: typeof item.icon === "string" ? item.icon : typeof item.iconName === "string" ? item.iconName : undefined,
          action:
            typeof item.action === "string"
              ? item.action
              : typeof item.kind === "string"
                ? item.kind
                : undefined,
        } as Record<string, unknown>;
      })
      .filter((value): value is Record<string, unknown> => Boolean(value));
  }

  const nestedEditorState = toRecord(source.payload)?.editorState;
  const nestedEditorItems = toArray(toRecord(nestedEditorState)?.items);
  if (nestedEditorItems) {
    return nestedEditorItems
      .map((value, index) => {
        const item = toRecord(value);
        if (!item) {
          return null;
        }

        const x = toFiniteNumber(item.x);
        const y = toFiniteNumber(item.y);
        const width = toFiniteNumber(item.width);
        const height = toFiniteNumber(item.height);
        if (x === null || y === null || width === null || height === null) {
          return null;
        }

        const normalizedKind = toNormalizedKind(item.type ?? item.kind);
        const label = typeof item.label === "string" ? item.label : undefined;

        return {
          ...item,
          id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : `${normalizedKind}-${index}`,
          type: normalizedKind,
          kind: normalizedKind,
          x,
          y,
          width,
          height,
          text: typeof item.text === "string" ? item.text : label,
          icon: typeof item.icon === "string" ? item.icon : typeof item.iconName === "string" ? item.iconName : undefined,
          action:
            typeof item.action === "string"
              ? item.action
              : typeof item.kind === "string"
                ? item.kind
                : undefined,
        } as Record<string, unknown>;
      })
      .filter((value): value is Record<string, unknown> => Boolean(value));
  }

  return [];
}

function shouldSkipUserActionButton(item: Record<string, unknown>): boolean {
  const action = typeof item.action === "string" ? item.action.trim().toLowerCase() : "";
  if (EXCLUDED_ACTIONS.has(action)) {
    return true;
  }

  const text = typeof item.text === "string" ? item.text.trim().toLowerCase() : "";
  return EXCLUDED_BUTTON_TEXT.has(text);
}

function parseMiniAssets(payloadObject: unknown): MiniButtonAsset[] {
  const items = getPayloadItems(payloadObject);

  return items
    .filter((item) => {
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      const kind = typeof item.kind === "string" ? item.kind.toLowerCase() : "";
      const resolved = type || kind;

      if (resolved !== "button" && resolved !== "icon-button" && resolved !== "button-slider") {
        return false;
      }

      if (resolved === "button" && shouldSkipUserActionButton(item)) {
        return false;
      }

      return true;
    })
    .map((item, index) => {
      const normalizedKind = toNormalizedKind(item.type ?? item.kind) as "button" | "icon-button" | "button-slider";

      return {
        id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id : `asset-${index}`,
        kind: normalizedKind,
        x: clampPositionScale(toFiniteNumber(item.x) ?? 0),
        y: clampPositionScale(toFiniteNumber(item.y) ?? 0),
        width: clampSizeScale(toFiniteNumber(item.width) ?? 0),
        height: clampSizeScale(toFiniteNumber(item.height) ?? 0),
        text:
          typeof item.text === "string"
            ? item.text
            : typeof item.label === "string"
              ? item.label
              : undefined,
        icon: typeof item.icon === "string" ? item.icon : typeof item.iconName === "string" ? item.iconName : undefined,
        tag: typeof item.tag === "string" ? item.tag : undefined,
      };
    });
}

function iconGlyph(iconName?: string): string {
  if (!iconName) {
    return "◯";
  }
  const cleaned = iconName.replace(/icon$/i, "").replace(/[^a-zA-Z0-9]/g, "");
  const short = cleaned.slice(0, 2).toUpperCase();
  return short.length > 0 ? short : "◯";
}

export default function MiniScoutField({ payloadObject, fieldImageUrl, className }: MiniScoutFieldProps) {
  const [containerSize, setContainerSize] = React.useState<BoxSize>({ width: 0, height: 0 });
  const [imageNaturalSize, setImageNaturalSize] = React.useState<BoxSize | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const assets = React.useMemo(() => parseMiniAssets(payloadObject), [payloadObject]);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const update = () => {
      setContainerSize({ width: element.clientWidth, height: element.clientHeight });
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!fieldImageUrl) {
      setImageNaturalSize(null);
      return;
    }

    const image = new Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }
      setImageNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (cancelled) {
        return;
      }
      setImageNaturalSize(null);
    };
    image.src = fieldImageUrl;

    return () => {
      cancelled = true;
    };
  }, [fieldImageUrl]);

  const fieldBounds = React.useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }

    if (!imageNaturalSize) {
      return {
        left: 0,
        top: 0,
        width: containerSize.width,
        height: containerSize.height,
      };
    }

    return getContainedBounds(containerSize, imageNaturalSize);
  }, [containerSize, imageNaturalSize]);

  const getAssetStyle = (asset: MiniButtonAsset): React.CSSProperties => {
    const xPercent = toPercentFromScale(asset.x) / 100;
    const yPercent = (100 - toPercentFromScale(asset.y)) / 100;
    const widthPercent = asset.width / 100;
    const heightPercent = asset.height / 100;

    return {
      position: "absolute",
      left: fieldBounds.left + fieldBounds.width * xPercent,
      top: fieldBounds.top + fieldBounds.height * yPercent,
      width: Math.max(8, fieldBounds.width * widthPercent),
      height: Math.max(8, fieldBounds.height * heightPercent),
      transform: "translate(-50%, -50%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.3)",
      background: "rgba(15, 23, 42, 0.92)",
      color: "white",
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1,
      pointerEvents: "none",
      userSelect: "none",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      padding: "0 6px",
    };
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#020617",
        overflow: "hidden",
      }}
    >
      <img
        src={fieldImageUrl}
        alt="Field"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "center",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />

      {assets.map((asset) => {
        const label =
          asset.kind === "icon-button"
            ? iconGlyph(asset.icon)
            : asset.kind === "button-slider"
              ? asset.text || asset.tag || "Slider"
              : asset.text || asset.tag || "Button";

        return (
          <div key={asset.id} style={getAssetStyle(asset)} title={asset.tag || asset.text || asset.icon || asset.id}>
            {label}
          </div>
        );
      })}
    </div>
  );
}
