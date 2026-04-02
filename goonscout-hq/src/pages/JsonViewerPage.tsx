import { ChangeEvent, FormEvent, Fragment, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import jsQR from "jsqr";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decodePitScoutingEntry, decodeQualitativeScoutingEntry, detectScoutType, extractRawEntries } from "@/lib/multiScoutDecode";
import { normalizeScoutingDataset, type ScoutingFieldMapping } from "@/lib/scoutingPayload";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonPath = Array<string | number>;

type EditingState =
  | {
      mode: "value";
      path: JsonPath;
      draft: string;
    }
  | {
      mode: "key";
      path: JsonPath;
      key: string;
      draft: string;
    };

type JsonViewerPageProps = {
  initialPath?: string;
  embedded?: boolean;
  projectId?: string;
  fieldMapping?: ScoutingFieldMapping | null;
  qualitativeContentHash?: string;
  pitContentHash?: string;
  onProjectDataChanged?: () => void;
};

type ContentHashValidationResult = {
  valid: boolean;
  message: string;
  field_mapping?: unknown;
  payload?: unknown;
};

function isScoutingFieldMapping(value: unknown): value is ScoutingFieldMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const mappingValue = (value as { mapping?: unknown }).mapping;
  return Boolean(mappingValue && typeof mappingValue === "object" && !Array.isArray(mappingValue));
}

function pathEquals(left: JsonPath, right: JsonPath): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((segment, index) => segment === right[index]);
}

function getValueAtPath(root: JsonValue, path: JsonPath): JsonValue {
  if (path.length === 0) {
    return root;
  }

  const [head, ...rest] = path;

  if (Array.isArray(root)) {
    if (typeof head !== "number" || head < 0 || head >= root.length) {
      throw new Error("Invalid array path.");
    }

    return getValueAtPath(root[head] as JsonValue, rest);
  }

  if (root !== null && typeof root === "object") {
    if (typeof head !== "string" || !(head in root)) {
      throw new Error("Invalid object path.");
    }

    return getValueAtPath((root as Record<string, JsonValue>)[head], rest);
  }

  throw new Error("Path does not target a JSON container.");
}

function setValueAtPath(root: JsonValue, path: JsonPath, nextValue: JsonValue): JsonValue {
  if (path.length === 0) {
    return nextValue;
  }

  const [head, ...rest] = path;

  if (Array.isArray(root)) {
    if (typeof head !== "number" || head < 0 || head >= root.length) {
      throw new Error("Invalid array path.");
    }

    const clone = [...root] as JsonValue[];
    clone[head] = setValueAtPath(clone[head] as JsonValue, rest, nextValue);
    return clone;
  }

  if (root !== null && typeof root === "object") {
    if (typeof head !== "string" || !(head in root)) {
      throw new Error("Invalid object path.");
    }

    const clone: Record<string, JsonValue> = { ...(root as Record<string, JsonValue>) };
    clone[head] = setValueAtPath(clone[head], rest, nextValue);
    return clone;
  }

  throw new Error("Path does not target a JSON container.");
}

function renameKeyAtPath(root: JsonValue, path: JsonPath, oldKey: string, newKey: string): JsonValue {
  const target = getValueAtPath(root, path);

  if (target === null || Array.isArray(target) || typeof target !== "object") {
    throw new Error("Target is not an object.");
  }

  const objectTarget = target as Record<string, JsonValue>;

  if (!(oldKey in objectTarget)) {
    throw new Error("Original key was not found.");
  }

  if (oldKey !== newKey && newKey in objectTarget) {
    throw new Error(`Key '${newKey}' already exists at this level.`);
  }

  const renamed: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(objectTarget)) {
    renamed[key === oldKey ? newKey : key] = value;
  }

  return setValueAtPath(root, path, renamed);
}

function deleteValueAtPath(root: JsonValue, path: JsonPath): JsonValue {
  if (path.length === 0) {
    throw new Error("Cannot delete the root JSON value.");
  }

  const parentPath = path.slice(0, -1);
  const targetKey = path[path.length - 1];
  const parent = getValueAtPath(root, parentPath);

  if (Array.isArray(parent)) {
    if (typeof targetKey !== "number" || targetKey < 0 || targetKey >= parent.length) {
      throw new Error("Invalid array entry path.");
    }

    const clone = [...parent] as JsonValue[];
    clone.splice(targetKey, 1);
    return setValueAtPath(root, parentPath, clone);
  }

  if (parent !== null && typeof parent === "object") {
    if (typeof targetKey !== "string" || !(targetKey in parent)) {
      throw new Error("Invalid object entry path.");
    }

    const clone: Record<string, JsonValue> = { ...(parent as Record<string, JsonValue>) };
    delete clone[targetKey];
    return setValueAtPath(root, parentPath, clone);
  }

  throw new Error("Path does not target a removable JSON entry.");
}

function parseDraftValue(previousValue: JsonValue, draft: string): JsonValue {
  if (typeof previousValue === "string") {
    try {
      return JSON.parse(draft) as JsonValue;
    } catch {
      return draft;
    }
  }

  return JSON.parse(draft) as JsonValue;
}

function JsonViewerPage({
  initialPath = "",
  embedded = false,
  projectId,
  fieldMapping,
  qualitativeContentHash = "",
  pitContentHash = "",
  onProjectDataChanged,
}: JsonViewerPageProps) {
  const [path, setPath] = useState(initialPath);
  const [jsonContent, setJsonContent] = useState("");
  const [jsonData, setJsonData] = useState<JsonValue | null>(null);
  const [status, setStatus] = useState(projectId ? "Upload a JSON file to start." : "Set a JSON path and load it.");
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeletingEntry, setIsDeletingEntry] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [pendingDeletePath, setPendingDeletePath] = useState<JsonPath | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanFrameRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scanLockedRef = useRef(false);
  const isScanningRef = useRef(false);
  const pathRef = useRef(initialPath);
  const qrImageInputRef = useRef<HTMLInputElement | null>(null);

  async function waitForVideoElement(timeoutMs = 2000): Promise<HTMLVideoElement> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (videoRef.current) {
        return videoRef.current;
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    throw new Error("Video element is not available.");
  }

  async function attachStreamToVideo(stream: MediaStream) {
    const video = await waitForVideoElement();

    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for camera video frames."));
      }, 4000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        video.onloadedmetadata = null;
        video.oncanplay = null;
      };

      const tryPlay = async () => {
        try {
          await video.play();
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        void tryPlay();
        return;
      }

      video.onloadedmetadata = () => {
        void tryPlay();
      };

      video.oncanplay = () => {
        void tryPlay();
      };
    });
  }

  function stopScanner() {
    setIsScanning(false);
    setIsScannerOpen(false);
    isScanningRef.current = false;

    if (scanFrameRef.current !== null) {
      cancelAnimationFrame(scanFrameRef.current);
      scanFrameRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    scanLockedRef.current = false;
  }

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, []);

  useEffect(() => {
    setPath(initialPath);
    pathRef.current = initialPath;

    if (initialPath.trim()) {
      void loadJsonFromPath(initialPath);
    }
  }, [initialPath]);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  async function persistJson(nextData: JsonValue) {
    const trimmedPath = pathRef.current.trim();
    if (!trimmedPath) {
      throw new Error("Please provide a valid JSON file path.");
    }

    const prettyJson = JSON.stringify(nextData, null, 2);
    await invoke("write_json_file", {
      path: trimmedPath,
      content: prettyJson,
    });

    setJsonData(nextData);
    setJsonContent(prettyJson);

    if (projectId) {
      onProjectDataChanged?.();
    }
  }

  async function commitEdit() {
    if (!editing || jsonData === null) {
      return;
    }

    setIsSavingEdit(true);

    try {
      if (editing.mode === "value") {
        const previousValue = getValueAtPath(jsonData, editing.path);
        const nextValue = parseDraftValue(previousValue, editing.draft);
        const updatedData = setValueAtPath(jsonData, editing.path, nextValue);
        await persistJson(updatedData);
        setStatus("JSON saved.");
      } else {
        const trimmedKey = editing.draft.trim();
        if (!trimmedKey) {
          throw new Error("Key cannot be empty.");
        }

        const updatedData = renameKeyAtPath(jsonData, editing.path, editing.key, trimmedKey);
        await persistJson(updatedData);
        setStatus("JSON saved.");
      }

      setEditing(null);
    } catch (error) {
      setStatus(`Unable to save JSON: ${String(error)}`);
    } finally {
      setIsSavingEdit(false);
    }
  }

  function cancelEdit() {
    if (!editing) {
      return;
    }

    setEditing(null);
    setStatus("Edit canceled.");
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void commitEdit();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  }

  function renderEditableInput() {
    if (!editing) {
      return null;
    }

    return (
      <input
        autoFocus
        value={editing.draft}
        onChange={(event) => setEditing({ ...editing, draft: event.currentTarget.value })}
        onBlur={cancelEdit}
        onKeyDown={handleEditorKeyDown}
        className="h-7 min-w-24 rounded border border-ring bg-background px-2 text-xs text-foreground outline-none"
      />
    );
  }

  function renderValue(value: JsonValue, depth: number, currentPath: JsonPath): ReactNode {
    const indent = "  ".repeat(depth);
    const nextIndent = "  ".repeat(depth + 1);

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <span className="text-slate-400">[]</span>;
      }

      return (
        <>
          <span className="text-slate-400">[</span>
          {"\n"}
          {value.map((item, index) => (
            <Fragment key={`arr-${depth}-${index}`}>
              {nextIndent}
              <span
                className="cursor-context-menu"
                onContextMenu={(event) => {
                  if (isSavingEdit || isDeletingEntry) {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  setPendingDeletePath([...currentPath, index]);
                }}
                title="Right-click to delete this entry"
              >
                {renderValue(item, depth + 1, [...currentPath, index])}
              </span>
              {index < value.length - 1 ? <span className="text-slate-400">,</span> : null}
              {"\n"}
            </Fragment>
          ))}
          {indent}
          <span className="text-slate-400">]</span>
        </>
      );
    }

    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);

      if (entries.length === 0) {
        return <span className="text-slate-400">{"{}"}</span>;
      }

      return (
        <>
          <span className="text-slate-400">{"{"}</span>
          {"\n"}
          {entries.map(([key, item], index) => {
            const isEditingKey = editing?.mode === "key" && editing.key === key && pathEquals(editing.path, currentPath);

            return (
              <Fragment key={`obj-${depth}-${key}-${index}`}>
                {nextIndent}
                {isEditingKey ? (
                  renderEditableInput()
                ) : (
                  <span
                    className="cursor-text text-sky-300"
                    onDoubleClick={() => {
                      if (isSavingEdit) {
                        return;
                      }

                      setEditing({
                        mode: "key",
                        path: currentPath,
                        key,
                        draft: key,
                      });
                      setStatus("Editing key. Press Enter to save or click away to cancel.");
                    }}
                  >
                    {JSON.stringify(key)}
                  </span>
                )}
                <span className="text-slate-400">: </span>
                {renderValue(item as JsonValue, depth + 1, [...currentPath, key])}
                {index < entries.length - 1 ? <span className="text-slate-400">,</span> : null}
                {"\n"}
              </Fragment>
            );
          })}
          {indent}
          <span className="text-slate-400">{"}"}</span>
        </>
      );
    }

    const isEditingValue = editing?.mode === "value" && pathEquals(editing.path, currentPath);
    if (isEditingValue) {
      return renderEditableInput();
    }

    if (typeof value === "string") {
      return (
        <span
          className="cursor-text text-emerald-300"
          onDoubleClick={() => {
            if (isSavingEdit) {
              return;
            }

            setEditing({
              mode: "value",
              path: currentPath,
              draft: value,
            });
            setStatus("Editing value. Press Enter to save or click away to cancel.");
          }}
        >
          {JSON.stringify(value)}
        </span>
      );
    }

    if (typeof value === "number") {
      return (
        <span
          className="cursor-text text-amber-300"
          onDoubleClick={() => {
            if (isSavingEdit) {
              return;
            }

            setEditing({
              mode: "value",
              path: currentPath,
              draft: String(value),
            });
            setStatus("Editing value. Press Enter to save or click away to cancel.");
          }}
        >
          {String(value)}
        </span>
      );
    }

    if (typeof value === "boolean") {
      return (
        <span
          className="cursor-text text-orange-300"
          onDoubleClick={() => {
            if (isSavingEdit) {
              return;
            }

            setEditing({
              mode: "value",
              path: currentPath,
              draft: String(value),
            });
            setStatus("Editing value. Press Enter to save or click away to cancel.");
          }}
        >
          {String(value)}
        </span>
      );
    }

    return (
      <span
        className="cursor-text text-rose-300"
        onDoubleClick={() => {
          if (isSavingEdit) {
            return;
          }

          setEditing({
            mode: "value",
            path: currentPath,
            draft: "null",
          });
          setStatus("Editing value. Press Enter to save or click away to cancel.");
        }}
      >
        null
      </span>
    );
  }

  async function loadJsonFromPath(nextPath: string): Promise<JsonValue | null> {
    const trimmedPath = nextPath.trim();
    if (!trimmedPath) {
      setStatus("Please provide a valid JSON file path.");
      return null;
    }

    setIsLoading(true);
    setStatus("Loading JSON file...");

    try {
      if (!fieldMapping || !fieldMapping.mapping || Object.keys(fieldMapping.mapping).length === 0) {
        throw new Error("Field mapping is required. Validate the match content hash in Config first.");
      }

      const formattedJson = await invoke<string>("read_json_file", { path: trimmedPath });
      const parsed = JSON.parse(formattedJson) as unknown;
      const sourceObject = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      const rawEntries = Array.isArray(parsed) ? parsed : sourceObject && Array.isArray(sourceObject.data) ? sourceObject.data : sourceObject ? [sourceObject] : [];
      const normalizedEntries = normalizeScoutingDataset(parsed, {
        fieldMapping,
        compressedOnly: true,
        requireFieldMapping: true,
      });
      if (rawEntries.length > 0 && normalizedEntries.length === 0) {
        throw new Error("No entries decoded. This file is legacy/non-compressed or mismatched with the selected field mapping.");
      }
      const normalizedValue = normalizedEntries as JsonValue;
      const normalizedJson = `${JSON.stringify(normalizedEntries, null, 2)}\n`;

      setJsonData(normalizedValue);
      setJsonContent(normalizedJson);
      setEditing(null);
      setStatus(`JSON loaded and normalized successfully. Entries: ${normalizedEntries.length}.`);
      return normalizedValue;
    } catch (error) {
      setJsonData(null);
      setJsonContent("");
      setEditing(null);
      setStatus(`Unable to load JSON: ${String(error)}`);
      return null;
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUploadJson() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof selected !== "string") {
      setStatus("No file selected.");
      return;
    }

    if (projectId) {
      try {
        setIsLoading(true);
        const projectJsonPath = await invoke<string>("upload_project_json", {
          projectId,
          sourcePath: selected,
        });

        setPath(projectJsonPath);
        await loadJsonFromPath(projectJsonPath);
        onProjectDataChanged?.();
        setStatus("JSON uploaded, normalized, and replaced successfully.");
      } catch (error) {
        setStatus(`Unable to upload JSON: ${String(error)}`);
      } finally {
        setIsLoading(false);
      }

      return;
    }

    setPath(selected);
    await loadJsonFromPath(selected);
  }

  async function handleScannedQr(payload: string) {
    if (scanLockedRef.current) {
      return;
    }

    scanLockedRef.current = true;
    stopScanner();

    const trimmedPath = path.trim();
    if (!projectId && !trimmedPath) {
      setStatus("Select a JSON path first before scanning.");
      return;
    }

    try {
      const parsedPayload = JSON.parse(payload) as unknown;
      const rawEntries = extractRawEntries(parsedPayload);

      const rawEntry = rawEntries[0];
      if (!rawEntry) {
        throw new Error("Scanned payload entry format is invalid.");
      }

      const scoutType = detectScoutType(rawEntry);
      if (!scoutType) {
        throw new Error("Unable to detect scoutType. QR payload must include scoutType or ft.");
      }

      if (scoutType === "match") {
        if (!fieldMapping || !fieldMapping.mapping || Object.keys(fieldMapping.mapping).length === 0) {
          throw new Error("Field mapping is required before scanning compressed match payloads.");
        }

        const normalizedEntries = normalizeScoutingDataset(rawEntry, {
          fieldMapping,
          compressedOnly: true,
          requireFieldMapping: true,
        });
        if (normalizedEntries.length === 0) {
          throw new Error("Scanned match payload did not contain a valid scouting entry.");
        }

        if (projectId) {
          await invoke("append_project_scan_entries", {
            projectId,
            scoutType: "match",
            entries: [rawEntry],
          });

          onProjectDataChanged?.();

          if (trimmedPath) {
            await loadJsonFromPath(trimmedPath);
          }
          setStatus("Match QR inserted at the top of data.json successfully.");
          return;
        }

        await invoke("append_json_entry", {
          path: trimmedPath,
          entryJson: JSON.stringify(rawEntry),
        });

        await loadJsonFromPath(trimmedPath);
        setStatus("Match QR inserted at the top successfully.");
        return;
      }

      if (!projectId) {
        throw new Error(`${scoutType} scans require a project context.`);
      }

      if (scoutType === "qualitative") {
        const hash = qualitativeContentHash.trim();
        if (!hash) {
          throw new Error("Qualitative content hash is not configured. Add it in Config before scanning qualitative QR codes.");
        }

        const validation = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
          contentHash: hash,
          expectedScoutType: "qualitative",
        });
        if (!validation.valid) {
          throw new Error(validation.message || "Qualitative content hash validation failed.");
        }
        if (!isScoutingFieldMapping(validation.field_mapping)) {
          throw new Error("Qualitative field mapping is missing or invalid for this hash.");
        }

        const decodedEntries = await decodeQualitativeScoutingEntry(
          rawEntry,
          validation.field_mapping,
          async (matchKey) => {
            try {
              return await invoke("fetch_tba_match", { matchKey });
            } catch {
              return null;
            }
          },
        );

        await invoke("append_project_scan_entries", {
          projectId,
          scoutType: "qualitative",
          entries: decodedEntries,
        });

        onProjectDataChanged?.();

        setStatus(`Qualitative QR decoded and saved to qual.json (${decodedEntries.length} team entries).`);
        return;
      }

      const pitHash = pitContentHash.trim();
      if (!pitHash) {
        throw new Error("Pit content hash is not configured. Add it in Config before scanning pit QR codes.");
      }

      const pitValidation = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
        contentHash: pitHash,
        expectedScoutType: "pit",
      });
      if (!pitValidation.valid) {
        throw new Error(pitValidation.message || "Pit content hash validation failed.");
      }

      const decodedPitEntry = decodePitScoutingEntry(rawEntry, pitValidation.payload ?? null);

      await invoke("append_project_scan_entries", {
        projectId,
        scoutType: "pit",
        entries: [decodedPitEntry],
      });

      onProjectDataChanged?.();

      setStatus("Pit QR decoded and saved to pit.json.");
      return;
    } catch (error) {
      setStatus(`QR scan found data but append failed: ${String(error)}`);
    }
  }

  async function ensurePathForScanActions(): Promise<string | null> {
    if (pathRef.current.trim()) {
      return pathRef.current.trim();
    }

    if (!projectId) {
      setStatus("Please set a JSON file path before scanning.");
      return null;
    }

    try {
      const generatedPath = await invoke<string>("ensure_project_json_for_scan", {
        projectId,
      });
      setPath(generatedPath);
      pathRef.current = generatedPath;
      return generatedPath;
    } catch (error) {
      setStatus(`Unable to prepare project JSON for scanning: ${String(error)}`);
      return null;
    }
  }

  async function handleUploadQrImage() {
    if (isSavingEdit || isDeletingEntry || isLoading || isScanning) {
      return;
    }

    const preparedPath = await ensurePathForScanActions();
    if (!preparedPath) {
      return;
    }

    qrImageInputRef.current?.click();
  }

  async function decodeQrFromImageFile(file: File) {
    const objectUrl = URL.createObjectURL(file);

    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const nextImage = new Image();
        nextImage.onload = () => resolve(nextImage);
        nextImage.onerror = () => reject(new Error("Unable to read selected image."));
        nextImage.src = objectUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Unable to access image canvas context.");
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (!code?.data) {
        throw new Error("No QR code found in selected image.");
      }

      await handleScannedQr(code.data);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleQrImageFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      setStatus("No QR image selected.");
      return;
    }

    try {
      setStatus("Decoding QR image...");
      await decodeQrFromImageFile(file);
    } catch (error) {
      setStatus(`Unable to decode QR image: ${String(error)}`);
    }
  }

  async function confirmDeleteEntry() {
    if (!pendingDeletePath || jsonData === null) {
      return;
    }

    setIsDeletingEntry(true);

    try {
      const updatedData = deleteValueAtPath(jsonData, pendingDeletePath);
      await persistJson(updatedData);
      setPendingDeletePath(null);
      setEditing(null);
      setStatus("Entry deleted successfully.");
    } catch (error) {
      setStatus(`Unable to delete entry: ${String(error)}`);
    } finally {
      setIsDeletingEntry(false);
    }
  }

  function scanVideoFrame() {
    if (!videoRef.current || !canvasRef.current || !isScanningRef.current) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      setStatus("Unable to access canvas context for scanning.");
      stopScanner();
      return;
    }

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code?.data) {
        void handleScannedQr(code.data);
      }
    }

    scanFrameRef.current = requestAnimationFrame(scanVideoFrame);
  }

  async function handleStartScanner() {
    const preparedPath = await ensurePathForScanActions();
    if (!preparedPath) {
      return;
    }

    if (isSavingEdit) {
      setStatus("Finish or cancel the current edit before scanning.");
      return;
    }

    try {
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        // Fallback for webcams/drivers that don't like facingMode constraints.
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      mediaStreamRef.current = stream;
      setIsScannerOpen(true);
      setIsScanning(true);
      isScanningRef.current = true;
      setStatus("Scanner active. Point your camera at a QR code.");

      await attachStreamToVideo(stream);

      scanFrameRef.current = requestAnimationFrame(scanVideoFrame);
    } catch (error) {
      stopScanner();
      setStatus(`Unable to start camera scanner: ${String(error)}`);
    }
  }

  return (
    <main className={embedded ? "w-full" : "mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-10 md:px-8"}>
      <Card className="w-full bg-card/90 backdrop-blur">
        <CardHeader>
          <CardTitle>GoonScout HQ JSON Viewer</CardTitle>
          <CardDescription>Enter an absolute path to a JSON file and render its contents.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
            }}
            className="space-y-6"
          >
            <div className="space-y-2">
              <Label htmlFor="json-path">JSON file path</Label>
              <div className="flex flex-col gap-2 md:flex-row">
                <Input
                  id="json-path"
                  value={path}
                  onChange={(event) => setPath(event.currentTarget.value)}
                  placeholder="C:\\data\\example.json"
                  autoComplete="off"
                  readOnly={Boolean(projectId)}
                />
                <Button type="button" variant="outline" onClick={handleUploadJson} disabled={isLoading || isSavingEdit}>
                  Upload JSON
                </Button>
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={isLoading || isSavingEdit || isDeletingEntry || isScanning}
                onClick={handleStartScanner}
              >
                {isScanning ? "Scanning..." : "Scan QR"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isLoading || isSavingEdit || isDeletingEntry || isScanning}
                onClick={() => void handleUploadQrImage()}
              >
                Upload QR Image
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={isSavingEdit || isDeletingEntry}
                onClick={() => {
                  setEditing(null);
                  setPendingDeletePath(null);
                  setJsonData(null);
                  setJsonContent("");
                  setStatus("Viewer reset.");
                }}
              >
                Clear
              </Button>
            </div>

            <p className="text-sm text-muted-foreground">{status}</p>

            <input
              ref={qrImageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void handleQrImageFileChange(event);
              }}
            />

            {isScannerOpen ? (
              <div className="fixed inset-0 z-50 bg-black">
                <video
                  id="qr-scanner-video"
                  ref={videoRef}
                  className="h-full w-full object-cover"
                  playsInline
                  autoPlay
                  muted
                />
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent p-4">
                  <p className="text-sm font-medium text-white">QR Scanner</p>
                  <p className="text-xs text-slate-200">Align the code inside your camera view.</p>
                </div>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 sm:p-8">
                  <div className="h-[min(78vw,78vh)] w-[min(78vw,78vh)] max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] rounded-2xl border-4 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] sm:max-h-[calc(100vh-4rem)] sm:max-w-[calc(100vw-4rem)]" />
                </div>
                <div className="absolute inset-x-0 bottom-0 flex justify-center p-5">
                  <Button type="button" variant="secondary" onClick={stopScanner}>
                    Stop Scanner
                  </Button>
                </div>
                <canvas ref={canvasRef} className="hidden" />
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="json-content">JSON content</Label>
              <div
                id="json-content"
                className="min-h-64 w-full overflow-auto rounded-md border border-input bg-background px-3 py-2"
              >
                <pre className="font-mono text-sm leading-6">
                  {jsonData !== null ? (
                    renderValue(jsonData, 0, [])
                  ) : jsonContent.trim() ? (
                    <span className="text-foreground">{jsonContent}</span>
                  ) : (
                    <span className="text-muted-foreground">No JSON loaded yet.</span>
                  )}
                </pre>
              </div>
            </div>

            <Dialog
              open={pendingDeletePath !== null}
              onOpenChange={(openState) => {
                if (!openState && !isDeletingEntry) {
                  setPendingDeletePath(null);
                }
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete entry?</DialogTitle>
                  <DialogDescription>
                    This will permanently remove the selected JSON entry from the file. This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPendingDeletePath(null)}
                    disabled={isDeletingEntry}
                  >
                    Cancel
                  </Button>
                  <Button type="button" variant="destructive" onClick={confirmDeleteEntry} disabled={isDeletingEntry}>
                    {isDeletingEntry ? "Deleting..." : "Delete"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default JsonViewerPage;
