import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BarChart3, FileJson, Folder, Home, Plus, Search, Settings, Upload } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import MiniScoutField from "@/components/MiniScoutField";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { extractEntryNumericMetrics, normalizeScoutingDataset, type ScoutingFieldMapping } from "./lib/scoutingPayload";
import JsonViewerPage from "@/pages/JsonViewerPage";

type WorkspaceProject = {
  id: string;
  name: string;
  folder_path: string;
  json_file_path?: string | null;
  updated_at: number;
};

type WorkspaceOverview = {
  root_path: string;
  projects_path: string;
  projects: WorkspaceProject[];
};

type ContentHashValidationResult = {
  valid: boolean;
  content_hash: string;
  scout_type?: string | null;
  message: string;
  field_mapping?: unknown;
  payload?: unknown;
  background_image?: string | null;
  background_location?: string | null;
};

type ProjectConfig = {
  matchContentHash: string;
  qualitativeContentHash: string;
  pitContentHash: string;
  tagPointValues?: Record<string, number>;
  backgroundImage?: string | null;
  backgroundLocation?: string | null;
  fieldMapping?: unknown;
  layoutPayload?: unknown;
  updatedAt?: number;
};

type ParsedRoute =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "team"; projectId: string; team: string }
  | { kind: "match"; projectId: string; team: string; match: number }
  | { kind: "viewer"; projectId?: string };

type ProjectSection = "overview" | "config" | "compare" | "picklist" | "scouts" | "teams" | "data";
type JsonEntry = Record<string, unknown>;
type TeamSeriesPoint = { match: number; value: number; scouter: string };
type TeamChartPoint = { match: number; value: number | null; compareValue: number | null; scouter: string; compareScouter: string };
type DataGraphType = "scatter" | "bar" | "weighted";

type WeightedMetricSelection = {
  id: string;
  baseMetric: string;
  phase: "auto" | "teleop";
  weight: number;
};

type SavedCycleMetric = {
  id: string;
  name: string;
  startTag: string;
  endTag: string;
};

type SavedPicklist = {
  id: string;
  name: string;
  metricWeights: Record<string, number>;
  order: string[];
  struckTeams: string[];
};

type DataMetricVariant = "value" | "accuracy" | "attempts";

type DataTagVariantGroup = {
  key: DataMetricVariant;
  label: string;
  tagsByPhase: Partial<Record<"auto" | "teleop", string>>;
};

type AllianceSide = "red" | "blue";

type AllianceContributionRow = {
  alliance: "Red" | "Blue";
  slot1: number;
  slot2: number;
  slot3: number;
  total: number;
  team1: string;
  team2: string;
  team3: string;
};

function parseHashRoute(hashValue: string): ParsedRoute {
  const hash = hashValue || "#/";

  const pathOnly = hash.split("?")[0] ?? "#/";
  const decodedPath = decodeURIComponent(pathOnly);
  const matchRoute = decodedPath.match(/^#\/project\/([^/]+)\/match\/([^/]+)\/(\d+)$/);
  const teamMatch = decodedPath.match(/^#\/project\/([^/]+)\/team\/(.+)$/);

  if (matchRoute) {
    return {
      kind: "match",
      projectId: matchRoute[1],
      team: matchRoute[2],
      match: Number(matchRoute[3]),
    };
  }

  if (teamMatch) {
    return {
      kind: "team",
      projectId: teamMatch[1],
      team: teamMatch[2],
    };
  }

  if (hash.startsWith("#/project/")) {
    const projectId = decodeURIComponent(hash.replace("#/project/", ""));
    if (projectId) {
      return { kind: "project", projectId };
    }
  }

  if (hash.startsWith("#/viewer")) {
    const queryIndex = hash.indexOf("?");
    const query = queryIndex >= 0 ? hash.slice(queryIndex + 1) : "";
    const params = new URLSearchParams(query);

    const projectIdValue = params.get("projectId") ?? undefined;

    return {
      kind: "viewer",
      projectId: projectIdValue,
    };
  }

  return { kind: "home" };
}

function buildProjectHash(projectId: string): string {
  return `#/project/${encodeURIComponent(projectId)}`;
}

function buildTeamHash(projectId: string, team: string): string {
  return `#/project/${encodeURIComponent(projectId)}/team/${encodeURIComponent(team)}`;
}

function buildMatchHash(projectId: string, team: string, match: number): string {
  return `#/project/${encodeURIComponent(projectId)}/match/${encodeURIComponent(team)}/${encodeURIComponent(String(match))}`;
}

function buildViewerHash(project?: WorkspaceProject): string {
  const params = new URLSearchParams();

  if (project?.id) {
    params.set("projectId", project.id);
  }

  const query = params.toString();
  return query.length ? `#/viewer?${query}` : "#/viewer";
}

function fromUnixSecondsToUpdatedLabel(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) {
    return "Last edited: Unknown";
  }

  const then = new Date(timestamp * 1000);
  const now = new Date();
  const msInDay = 24 * 60 * 60 * 1000;

  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      msInDay,
  );

  if (dayDiff <= 0) {
    return "Last edited: Today";
  }

  if (dayDiff === 1) {
    return "Last edited: Yesterday";
  }

  return `Last edited: ${then.toLocaleString("en-US", { month: "short" })} ${then.getDate()}`;
}

function isScoutingFieldMapping(value: unknown): value is ScoutingFieldMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const mappingValue = (value as { mapping?: unknown }).mapping;
  return Boolean(mappingValue && typeof mappingValue === "object" && !Array.isArray(mappingValue));
}

function splitMetricTag(tag: string): { phase: "auto" | "teleop"; metric: string } | null {
  if (tag.startsWith("auto.")) {
    return { phase: "auto", metric: tag.slice("auto.".length) };
  }
  if (tag.startsWith("teleop.")) {
    return { phase: "teleop", metric: tag.slice("teleop.".length) };
  }
  return null;
}

function formatMetricTagLabel(tag: string): string {
  const parsed = splitMetricTag(tag);
  if (!parsed) {
    return tag;
  }
  return `${parsed.metric} • ${parsed.phase}`;
}

function compareMetricTags(leftTag: string, rightTag: string): number {
  const left = splitMetricTag(leftTag);
  const right = splitMetricTag(rightTag);

  if (left && right) {
    const baseCompare = left.metric.localeCompare(right.metric);
    if (baseCompare !== 0) {
      return baseCompare;
    }

    const phaseOrder = left.phase === right.phase ? 0 : left.phase === "auto" ? -1 : 1;
    if (phaseOrder !== 0) {
      return phaseOrder;
    }

    return leftTag.localeCompare(rightTag);
  }

  if (left && !right) {
    return -1;
  }

  if (!left && right) {
    return 1;
  }

  return leftTag.localeCompare(rightTag);
}

function parseMetricVariant(metric: string): { base: string; variant: DataMetricVariant | null } {
  if (metric.endsWith(".successes") || metric.endsWith(".fails")) {
    return { base: metric.replace(/\.(successes|fails)$/i, ""), variant: null };
  }

  if (metric.endsWith(".accuracy")) {
    return { base: metric.slice(0, -".accuracy".length), variant: "accuracy" };
  }

  if (metric.endsWith(".attempts")) {
    return { base: metric.slice(0, -".attempts".length), variant: "attempts" };
  }

  return { base: metric, variant: "value" };
}

function buildTagFromSelection(phase: "auto" | "teleop", base: string, variant: DataMetricVariant): string {
  if (variant === "value") {
    return `${phase}.${base}`;
  }

  return `${phase}.${base}.${variant}`;
}

function highlightSearchTerm(text: string, term: string): React.ReactNode {
  if (!term.trim()) {
    return text;
  }

  const normalizedTerm = term.trim();
  const matcher = new RegExp(`(${normalizedTerm.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")})`, "ig");
  const parts = text.split(matcher);

  return parts.map((part, index) =>
    part.toLowerCase() === normalizedTerm.toLowerCase() ? (
      <mark key={`highlight-${index}`} className="rounded bg-yellow-300/35 px-0.5 text-white">
        {part}
      </mark>
    ) : (
      <React.Fragment key={`highlight-${index}`}>{part}</React.Fragment>
    ),
  );
}

function parseLayoutPayload(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (value && typeof value === "object") {
    return value;
  }

  return null;
}

const cardGradient =
  "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.16), transparent 42%), radial-gradient(circle at 80% 35%, rgba(30,64,175,0.25), transparent 45%), linear-gradient(180deg, rgba(15,23,42,0.9), rgba(10,15,32,0.95))";

function App() {
  const [hashRoute, setHashRoute] = React.useState(window.location.hash || "#/");
  const [workspace, setWorkspace] = React.useState<WorkspaceOverview | null>(null);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = React.useState(true);
  const [workspaceError, setWorkspaceError] = React.useState("");
  const [search, setSearch] = React.useState("");

  const [isCreateDialogOpen, setIsCreateDialogOpen] = React.useState(false);
  const [isDebugDialogOpen, setIsDebugDialogOpen] = React.useState(false);
  const [isCreatingProject, setIsCreatingProject] = React.useState(false);
  const [isRunningDebugValidation, setIsRunningDebugValidation] = React.useState(false);
  const [isSettingRootFolder, setIsSettingRootFolder] = React.useState(false);
  const [createProjectName, setCreateProjectName] = React.useState("Untitled Project");
  const [createProjectContentHash, setCreateProjectContentHash] = React.useState("");
  const [debugContentHash, setDebugContentHash] = React.useState("");
  const [debugScoutType, setDebugScoutType] = React.useState<"match" | "qualitative" | "pit">("match");
  const [debugResult, setDebugResult] = React.useState<ContentHashValidationResult | null>(null);
  const [debugMessage, setDebugMessage] = React.useState("");

  const [projectConfig, setProjectConfig] = React.useState<ProjectConfig>({
    matchContentHash: "",
    qualitativeContentHash: "",
    pitContentHash: "",
    tagPointValues: {},
    backgroundImage: null,
    backgroundLocation: null,
    fieldMapping: null,
  });
  const [configMatchHashDraft, setConfigMatchHashDraft] = React.useState("");
  const [configQualitativeHashDraft, setConfigQualitativeHashDraft] = React.useState("");
  const [configPitHashDraft, setConfigPitHashDraft] = React.useState("");
  const [configStatus, setConfigStatus] = React.useState("");
  const [isSavingConfig, setIsSavingConfig] = React.useState(false);
  const [decodeFieldMapping, setDecodeFieldMapping] = React.useState<ScoutingFieldMapping | null>(null);

  const [projectSection, setProjectSection] = React.useState<ProjectSection>("overview");
  const [teamSearch, setTeamSearch] = React.useState("");
  const [teamNoteSearch, setTeamNoteSearch] = React.useState("");
  const [teamQualitativeSearch, setTeamQualitativeSearch] = React.useState("");
  const [teamPitSearch, setTeamPitSearch] = React.useState("");
  const [teamNumbers, setTeamNumbers] = React.useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = React.useState("");
  const [scoutSearch, setScoutSearch] = React.useState("");
  const [scoutNames, setScoutNames] = React.useState<string[]>([]);
  const [selectedScout, setSelectedScout] = React.useState("");
  const [jsonEntries, setJsonEntries] = React.useState<JsonEntry[]>([]);
  const [qualitativeEntries, setQualitativeEntries] = React.useState<JsonEntry[]>([]);
  const [pitEntries, setPitEntries] = React.useState<JsonEntry[]>([]);
  const [selectedDataXTag, setSelectedDataXTag] = React.useState("");
  const [selectedDataYTag, setSelectedDataYTag] = React.useState("");
  const [selectedDataYTagSecondary, setSelectedDataYTagSecondary] = React.useState("");
  const [activeDataAxis, setActiveDataAxis] = React.useState<"x" | "y" | "y2" | null>("x");
  const [dataGraphType, setDataGraphType] = React.useState<DataGraphType>("scatter");
  const [selectedDataXBaseMetric, setSelectedDataXBaseMetric] = React.useState("");
  const [selectedDataYBaseMetric, setSelectedDataYBaseMetric] = React.useState("");
  const [selectedDataY2BaseMetric, setSelectedDataY2BaseMetric] = React.useState("");
  const [selectedDataXVariant, setSelectedDataXVariant] = React.useState<DataMetricVariant>("value");
  const [selectedDataYVariant, setSelectedDataYVariant] = React.useState<DataMetricVariant>("value");
  const [selectedDataY2Variant, setSelectedDataY2Variant] = React.useState<DataMetricVariant>("value");
  const [expandedDataMetricBase, setExpandedDataMetricBase] = React.useState("");
  const [expandedDataMetricVariant, setExpandedDataMetricVariant] = React.useState<DataMetricVariant | null>(null);
  const [selectedDataXPhase, setSelectedDataXPhase] = React.useState<"auto" | "teleop">("auto");
  const [selectedDataYPhase, setSelectedDataYPhase] = React.useState<"auto" | "teleop">("teleop");
  const [selectedDataY2Phase, setSelectedDataY2Phase] = React.useState<"auto" | "teleop">("auto");
  const [weightedMetricSelections, setWeightedMetricSelections] = React.useState<WeightedMetricSelection[]>([]);
  const [dataTeamSearch, setDataTeamSearch] = React.useState("");
  const [picklistMetricSearch, setPicklistMetricSearch] = React.useState("");
  const [dataTagSelectionError, setDataTagSelectionError] = React.useState("");
  const [isDataGraphFullscreen, setIsDataGraphFullscreen] = React.useState(false);
  const [selectedTeamTag, setSelectedTeamTag] = React.useState("");
  const [expandedTeamMetricBase, setExpandedTeamMetricBase] = React.useState("");
  const [compareTeamInput, setCompareTeamInput] = React.useState("");
  const [isTeamGraphFullscreen, setIsTeamGraphFullscreen] = React.useState(false);
  const [animatedChartData, setAnimatedChartData] = React.useState<TeamChartPoint[]>([]);
  const [isLoadingIndex, setIsLoadingIndex] = React.useState(false);
  const [indexError, setIndexError] = React.useState("");
  const [savedCycleMetrics, setSavedCycleMetrics] = React.useState<SavedCycleMetric[]>([]);
  const [cycleStartTag, setCycleStartTag] = React.useState("");
  const [cycleEndTag, setCycleEndTag] = React.useState("");
  const [cycleMetricName, setCycleMetricName] = React.useState("");
  const [picklists, setPicklists] = React.useState<SavedPicklist[]>([]);
  const [activePicklistId, setActivePicklistId] = React.useState<string>("default");
  const [newPicklistName, setNewPicklistName] = React.useState("");
  const [draggingPickTeam, setDraggingPickTeam] = React.useState<string | null>(null);
  const [isSavingTagPoints, setIsSavingTagPoints] = React.useState(false);

  const [redAllianceTeams, setRedAllianceTeams] = React.useState<[string, string, string]>(["", "", ""]);
  const [blueAllianceTeams, setBlueAllianceTeams] = React.useState<[string, string, string]>(["", "", ""]);
  const [compareScoreMode, setCompareScoreMode] = React.useState<"tag" | "phase">("tag");
  const [compareMetricTagSelection, setCompareMetricTagSelection] = React.useState("");
  const [compareMetricWeight, setCompareMetricWeight] = React.useState(1);
  const [comparePhaseSelection, setComparePhaseSelection] = React.useState<"auto" | "teleop">("auto");
  const [comparePhasePointValue, setComparePhasePointValue] = React.useState(1);
  const [matchGeneralSearch, setMatchGeneralSearch] = React.useState("");

  React.useEffect(() => {
    const onHashChange = () => {
      setHashRoute(window.location.hash || "#/");
    };

    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const refreshWorkspace = React.useCallback(async () => {
    setIsLoadingWorkspace(true);

    try {
      const overview = await invoke<WorkspaceOverview>("get_goonhq_workspace_overview");
      setWorkspace(overview);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(`Unable to load local workspace: ${String(error)}`);
    } finally {
      setIsLoadingWorkspace(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const route = React.useMemo(() => parseHashRoute(hashRoute), [hashRoute]);

  const selectedProject = React.useMemo(() => {
    if (!workspace) {
      return null;
    }

    const projectId =
      route.kind === "project"
        ? route.projectId
        : route.kind === "viewer"
          ? route.projectId
          : route.kind === "team"
            ? route.projectId
            : route.kind === "match"
              ? route.projectId
            : undefined;
    if (!projectId) {
      return null;
    }

    return workspace.projects.find((project) => project.id === projectId) ?? null;
  }, [route, workspace]);

  React.useEffect(() => {
    setTeamSearch("");
    setSelectedTeam("");
    setScoutSearch("");
    setSelectedScout("");
    setIndexError("");

    const needsIndexForProjectTabs = route.kind === "project" && (projectSection === "teams" || projectSection === "scouts" || projectSection === "data");
    const needsIndexForTeamPage = route.kind === "team";
    const needsIndexForMatchPage = route.kind === "match";

    if (!needsIndexForProjectTabs && !needsIndexForTeamPage && !needsIndexForMatchPage) {
      return;
    }

    if (!selectedProject?.json_file_path) {
      setJsonEntries([]);
      setTeamNumbers([]);
      setScoutNames([]);
      return;
    }

    if (!decodeFieldMapping) {
      setJsonEntries([]);
      setTeamNumbers([]);
      setScoutNames([]);
      setIndexError("Missing field mapping. Validate the project match content hash in Config to decode compressed data.");
      return;
    }

    let isCancelled = false;

    const loadIndex = async () => {
      setIsLoadingIndex(true);

      try {
        const content = await invoke<string>("read_json_file", {
          path: selectedProject.json_file_path,
        });

        const parsed = JSON.parse(content) as unknown;
        const sourceObject = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        const rawEntries = Array.isArray(parsed) ? parsed : sourceObject && Array.isArray(sourceObject.data) ? sourceObject.data : sourceObject ? [sourceObject] : [];
        const entries = normalizeScoutingDataset(parsed, {
          fieldMapping: decodeFieldMapping,
          compressedOnly: true,
          requireFieldMapping: true,
        });

        if (rawEntries.length > 0 && entries.length === 0) {
          throw new Error("No entries decoded. File appears to be non-compressed/legacy format or has mismatched field mapping.");
        }

        const uniqueTeams = new Set<string>();
        const uniqueScouts = new Set<string>();

        for (const entry of entries) {
          const teamValue = entry.team;
          if (typeof teamValue === "string" && teamValue.trim()) {
            uniqueTeams.add(teamValue.trim());
          } else if (typeof teamValue === "number") {
            uniqueTeams.add(String(teamValue));
          }

          const scoutValue = entry.scouter;
          if (typeof scoutValue === "string" && scoutValue.trim()) {
            uniqueScouts.add(scoutValue.trim());
          }
        }

        if (!isCancelled) {
          setJsonEntries(entries);
          setTeamNumbers(Array.from(uniqueTeams).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })));
          setScoutNames(Array.from(uniqueScouts).sort((left, right) => left.localeCompare(right)));
          setIndexError("");
        }
      } catch (error) {
        if (!isCancelled) {
          setJsonEntries([]);
          setTeamNumbers([]);
          setScoutNames([]);
          setIndexError(`Unable to read teams/scouts from JSON: ${String(error)}`);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingIndex(false);
        }
      }
    };

    void loadIndex();

    return () => {
      isCancelled = true;
    };
  }, [decodeFieldMapping, projectSection, route.kind, selectedProject?.json_file_path]);

  React.useEffect(() => {
    if ((route.kind !== "project" && route.kind !== "team" && route.kind !== "match") || !selectedProject) {
      return;
    }

    let isCancelled = false;

    const loadProjectConfig = async () => {
      try {
        const loaded = await invoke<ProjectConfig>("get_project_config", {
          projectId: selectedProject.id,
        });

        if (!isCancelled) {
          setProjectConfig({
            matchContentHash: String(loaded.matchContentHash ?? ""),
            qualitativeContentHash: String(loaded.qualitativeContentHash ?? ""),
            pitContentHash: String(loaded.pitContentHash ?? ""),
            tagPointValues:
              loaded.tagPointValues && typeof loaded.tagPointValues === "object" && !Array.isArray(loaded.tagPointValues)
                ? (loaded.tagPointValues as Record<string, number>)
                : {},
            backgroundImage: loaded.backgroundImage ?? null,
            backgroundLocation: loaded.backgroundLocation ?? null,
            fieldMapping: loaded.fieldMapping ?? null,
            layoutPayload: loaded.layoutPayload ?? null,
            updatedAt: loaded.updatedAt,
          });
        }
      } catch {
        if (!isCancelled) {
          setProjectConfig({
            matchContentHash: "",
            qualitativeContentHash: "",
            pitContentHash: "",
            tagPointValues: {},
            backgroundImage: null,
            backgroundLocation: null,
            fieldMapping: null,
            layoutPayload: null,
          });
        }
      }
    };

    void loadProjectConfig();

    return () => {
      isCancelled = true;
    };
  }, [route.kind, selectedProject]);

  React.useEffect(() => {
    setConfigMatchHashDraft(projectConfig.matchContentHash ?? "");
    setConfigQualitativeHashDraft(projectConfig.qualitativeContentHash ?? "");
    setConfigPitHashDraft(projectConfig.pitContentHash ?? "");
  }, [projectConfig.matchContentHash, projectConfig.pitContentHash, projectConfig.qualitativeContentHash]);

  React.useEffect(() => {
    if ((route.kind !== "project" && route.kind !== "team" && route.kind !== "match") || !selectedProject) {
      setDecodeFieldMapping(null);
      return;
    }

    let isCancelled = false;

    const resolveMapping = async () => {
      const storedMapping = isScoutingFieldMapping(projectConfig.fieldMapping) ? projectConfig.fieldMapping : null;
      const hasStoredMapping = Boolean(storedMapping);
      const hasStoredLayoutPayload = Boolean(parseLayoutPayload(projectConfig.layoutPayload));
      const hasStoredBackgroundImage = Boolean(projectConfig.backgroundImage);

      if (hasStoredMapping && !isCancelled) {
        setDecodeFieldMapping(storedMapping);
      }

      if (hasStoredMapping && hasStoredLayoutPayload && hasStoredBackgroundImage) {
        return;
      }

      const hash = projectConfig.matchContentHash?.trim();
      if (!hash) {
        if (!isCancelled) {
            setDecodeFieldMapping(storedMapping);
        }
        return;
      }

      try {
        const validation = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
          contentHash: hash,
          expectedScoutType: "match",
        });

        if (!validation.valid || !isScoutingFieldMapping(validation.field_mapping)) {
          if (!isCancelled) {
            if (hasStoredMapping) {
              setDecodeFieldMapping(storedMapping);
            } else {
              setDecodeFieldMapping(null);
              setIndexError(`Unable to resolve field mapping from Supabase for hash '${hash}'.`);
            }
          }
          return;
        }

        if (isCancelled) {
          return;
        }

        const nextConfig: ProjectConfig = {
          ...projectConfig,
          fieldMapping: validation.field_mapping,
          layoutPayload: validation.payload ?? projectConfig.layoutPayload ?? null,
          backgroundImage: validation.background_image ?? projectConfig.backgroundImage ?? null,
          backgroundLocation: validation.background_location ?? projectConfig.backgroundLocation ?? null,
        };

        setDecodeFieldMapping(validation.field_mapping);

        const configChanged =
          JSON.stringify(nextConfig.fieldMapping) !== JSON.stringify(projectConfig.fieldMapping) ||
          JSON.stringify(nextConfig.layoutPayload ?? null) !== JSON.stringify(projectConfig.layoutPayload ?? null) ||
          nextConfig.backgroundImage !== projectConfig.backgroundImage ||
          JSON.stringify(nextConfig.backgroundLocation ?? null) !== JSON.stringify(projectConfig.backgroundLocation ?? null);

        if (configChanged) {
          setProjectConfig(nextConfig);

          await invoke("save_project_config", {
            projectId: selectedProject.id,
            config: nextConfig,
          });
        }
      } catch {
        if (!isCancelled) {
          if (hasStoredMapping) {
            setDecodeFieldMapping(storedMapping);
          } else {
            setDecodeFieldMapping(null);
            setIndexError("Failed to fetch field mapping from Supabase.");
          }
        }
      }
    };

    void resolveMapping();

    return () => {
      isCancelled = true;
    };
  }, [projectConfig, route.kind, selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      return;
    }

    let isCancelled = false;

    const loadProjectDataFiles = async () => {
      try {
        const loadedMetrics = await invoke<SavedCycleMetric[]>("read_or_init_project_data_file", {
          projectId: selectedProject.id,
          fileName: "metrics.json",
          defaultContent: [],
        });

        if (!isCancelled) {
          setSavedCycleMetrics(Array.isArray(loadedMetrics) ? loadedMetrics : []);
        }
      } catch {
        if (!isCancelled) {
          setSavedCycleMetrics([]);
        }
      }

      try {
        const loadedPicklists = await invoke<SavedPicklist[]>("read_or_init_project_data_file", {
          projectId: selectedProject.id,
          fileName: "picklists.json",
          defaultContent: [
            {
              id: "default",
              name: "Default Picklist",
              metricWeights: {},
              order: [],
              struckTeams: [],
            },
          ],
        });

        if (!isCancelled) {
          const validPicklists = Array.isArray(loadedPicklists) && loadedPicklists.length > 0 ? loadedPicklists : [
            {
              id: "default",
              name: "Default Picklist",
              metricWeights: {},
              order: [],
              struckTeams: [],
            },
          ];
          setPicklists(validPicklists);
          setActivePicklistId((previous) => (validPicklists.some((picklist) => picklist.id === previous) ? previous : validPicklists[0].id));
        }
      } catch {
        if (!isCancelled) {
          setPicklists([
            {
              id: "default",
              name: "Default Picklist",
              metricWeights: {},
              order: [],
              struckTeams: [],
            },
          ]);
          setActivePicklistId("default");
        }
      }
    };

    void loadProjectDataFiles();

    return () => {
      isCancelled = true;
    };
  }, [selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      return;
    }

    void invoke("write_project_data_file", {
      projectId: selectedProject.id,
      fileName: "metrics.json",
      content: savedCycleMetrics,
    });
  }, [savedCycleMetrics, selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      return;
    }

    void invoke("write_project_data_file", {
      projectId: selectedProject.id,
      fileName: "picklists.json",
      content: picklists,
    });
  }, [picklists, selectedProject]);

  React.useEffect(() => {
    if (!selectedProject) {
      setQualitativeEntries([]);
      setPitEntries([]);
      return;
    }

    let isCancelled = false;

    const normalizeEntries = (value: unknown): JsonEntry[] => {
      if (!Array.isArray(value)) {
        return [];
      }

      return value.filter((item): item is JsonEntry => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    };

    const loadQualAndPitData = async () => {
      const qualitativeHash = projectConfig.qualitativeContentHash?.trim() ?? "";
      const pitHash = projectConfig.pitContentHash?.trim() ?? "";

      if (!qualitativeHash) {
        if (!isCancelled) {
          setQualitativeEntries([]);
        }
      } else {
        try {
          const loaded = await invoke<unknown>("read_or_init_project_data_file", {
            projectId: selectedProject.id,
            fileName: "qual.json",
            defaultContent: [],
          });
          if (!isCancelled) {
            setQualitativeEntries(normalizeEntries(loaded));
          }
        } catch {
          if (!isCancelled) {
            setQualitativeEntries([]);
          }
        }
      }

      if (!pitHash) {
        if (!isCancelled) {
          setPitEntries([]);
        }
      } else {
        try {
          const loaded = await invoke<unknown>("read_or_init_project_data_file", {
            projectId: selectedProject.id,
            fileName: "pit.json",
            defaultContent: [],
          });
          if (!isCancelled) {
            setPitEntries(normalizeEntries(loaded));
          }
        } catch {
          if (!isCancelled) {
            setPitEntries([]);
          }
        }
      }
    };

    void loadQualAndPitData();

    return () => {
      isCancelled = true;
    };
  }, [projectConfig.pitContentHash, projectConfig.qualitativeContentHash, selectedProject]);

  const filteredTeamNumbers = React.useMemo(() => {
    const term = teamSearch.trim().toLowerCase();
    if (!term) {
      return teamNumbers;
    }

    return teamNumbers.filter((team) => team.toLowerCase().includes(term));
  }, [teamNumbers, teamSearch]);

  const filteredScoutNames = React.useMemo(() => {
    const term = scoutSearch.trim().toLowerCase();
    if (!term) {
      return scoutNames;
    }

    return scoutNames.filter((scout) => scout.toLowerCase().includes(term));
  }, [scoutNames, scoutSearch]);

  const activeTeam = route.kind === "team" ? route.team : "";
  const statsTeam = route.kind === "team" ? activeTeam : selectedTeam;
  const excludedDataTags = React.useMemo(() => new Set(["team", "match", "scouter", "scouters"]), []);

  const allNumericTags = React.useMemo(() => {
    const tags = new Set<string>();

    for (const entry of jsonEntries) {
      const numericMetrics = extractEntryNumericMetrics(entry);
      for (const tag of Object.keys(numericMetrics)) {
        if (!excludedDataTags.has(tag)) {
          tags.add(tag);
        }
      }
    }

    return Array.from(tags).sort((left, right) => left.localeCompare(right));
  }, [excludedDataTags, jsonEntries]);

  const tagPointValueMap = React.useMemo(() => {
    return projectConfig.tagPointValues ?? {};
  }, [projectConfig.tagPointValues]);

  const configurableTagBases = React.useMemo(() => {
    const bases = new Set<string>();

    for (const tag of allNumericTags) {
      const split = splitMetricTag(tag);
      if (!split) {
        continue;
      }

      const parsed = parseMetricVariant(split.metric);
      if (!parsed.variant) {
        continue;
      }

      if (parsed.variant !== "value") {
        continue;
      }

      bases.add(parsed.base);
    }

    return Array.from(bases.values()).sort((left, right) => left.localeCompare(right));
  }, [allNumericTags]);

  const getConfiguredTagPointValue = React.useCallback(
    (tag: string): number => {
      const split = splitMetricTag(tag);
      if (!split) {
        return 1;
      }

      const parsed = parseMetricVariant(split.metric);
      const value = tagPointValueMap[parsed.base];

      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }

      return 1;
    },
    [tagPointValueMap],
  );

  const dataTagGroups = React.useMemo(() => {
    const grouped = new Map<string, Map<DataMetricVariant, DataTagVariantGroup>>();

    for (const tag of allNumericTags) {
      const phaseTag = splitMetricTag(tag);
      if (!phaseTag) {
        continue;
      }

      const parsed = parseMetricVariant(phaseTag.metric);
      if (!parsed.variant) {
        continue;
      }

      const baseGroup = grouped.get(parsed.base) ?? new Map<DataMetricVariant, DataTagVariantGroup>();
      const existing = baseGroup.get(parsed.variant) ?? {
        key: parsed.variant,
        label: parsed.variant,
        tagsByPhase: {},
      };
      existing.tagsByPhase[phaseTag.phase] = tag;
      baseGroup.set(parsed.variant, existing);
      grouped.set(parsed.base, baseGroup);
    }

    const variantOrder: Record<DataMetricVariant, number> = {
      value: 0,
      accuracy: 1,
      attempts: 2,
    };

    return Array.from(grouped.entries())
      .map(([base, variants]) => ({
        base,
        variants: Array.from(variants.values()).sort((left, right) => variantOrder[left.key] - variantOrder[right.key]),
      }))
      .sort((left, right) => left.base.localeCompare(right.base));
  }, [allNumericTags]);

  const basePhaseMetrics = React.useMemo(() => {
    const baseToPhases = new Map<string, Set<"auto" | "teleop">>();

    for (const tag of allNumericTags) {
      if (tag.startsWith("auto.")) {
        const base = tag.slice("auto.".length);
        const phases = baseToPhases.get(base) ?? new Set<"auto" | "teleop">();
        phases.add("auto");
        baseToPhases.set(base, phases);
        continue;
      }

      if (tag.startsWith("teleop.")) {
        const base = tag.slice("teleop.".length);
        const phases = baseToPhases.get(base) ?? new Set<"auto" | "teleop">();
        phases.add("teleop");
        baseToPhases.set(base, phases);
      }
    }

    return Array.from(baseToPhases.entries())
      .map(([base, phases]) => ({
        base,
        phases: Array.from(phases.values()).sort(),
      }))
      .sort((left, right) => left.base.localeCompare(right.base));
  }, [allNumericTags]);

  const resolveAxisTag = React.useCallback(
    (axis: "x" | "y" | "y2") => {
      const axisBase = axis === "x" ? selectedDataXBaseMetric : axis === "y" ? selectedDataYBaseMetric : selectedDataY2BaseMetric;
      const axisVariant = axis === "x" ? selectedDataXVariant : axis === "y" ? selectedDataYVariant : selectedDataY2Variant;
      const axisPhase = axis === "x" ? selectedDataXPhase : axis === "y" ? selectedDataYPhase : selectedDataY2Phase;

      const group = dataTagGroups.find((item) => item.base === axisBase);
      if (!group) {
        return "";
      }

      const variant = group.variants.find((item) => item.key === axisVariant) ?? group.variants[0];
      if (!variant) {
        return "";
      }

      const exact = variant.tagsByPhase[axisPhase];
      if (exact) {
        return exact;
      }

      const fallbackPhase = (Object.keys(variant.tagsByPhase)[0] as "auto" | "teleop" | undefined) ?? "auto";
      return variant.tagsByPhase[fallbackPhase] ?? buildTagFromSelection(fallbackPhase, group.base, variant.key);
    },
    [
      dataTagGroups,
      selectedDataXBaseMetric,
      selectedDataXPhase,
      selectedDataXVariant,
      selectedDataY2BaseMetric,
      selectedDataY2Phase,
      selectedDataY2Variant,
      selectedDataYBaseMetric,
      selectedDataYPhase,
      selectedDataYVariant,
    ],
  );

  React.useEffect(() => {
    setSelectedDataXTag((previous) => {
      if (previous && allNumericTags.includes(previous)) {
        return previous;
      }
      return allNumericTags[0] ?? "";
    });

    setSelectedDataYTag((previous) => {
      if (previous && allNumericTags.includes(previous)) {
        return previous;
      }
      if (allNumericTags.length >= 2) {
        return allNumericTags[1];
      }
      return allNumericTags[0] ?? "";
    });
  }, [allNumericTags]);

  React.useEffect(() => {
    const firstBase = dataTagGroups[0]?.base ?? "";
    const firstVariant = dataTagGroups[0]?.variants[0]?.key ?? "value";

    const normalizeAxisSelection = (
      currentBase: string,
      currentVariant: DataMetricVariant,
      currentPhase: "auto" | "teleop",
    ): { base: string; variant: DataMetricVariant; phase: "auto" | "teleop" } => {
      const group = dataTagGroups.find((item) => item.base === currentBase) ?? dataTagGroups[0];
      if (!group) {
        return {
          base: "",
          variant: "value",
          phase: "auto",
        };
      }

      const variant = group.variants.find((item) => item.key === currentVariant) ?? group.variants[0];
      if (!variant) {
        return {
          base: group.base,
          variant: "value",
          phase: currentPhase,
        };
      }

      const preferredPhase = variant.tagsByPhase[currentPhase] ? currentPhase : (Object.keys(variant.tagsByPhase)[0] as "auto" | "teleop" | undefined) ?? "auto";

      return {
        base: group.base,
        variant: variant.key,
        phase: preferredPhase,
      };
    };

    const normalizedX = normalizeAxisSelection(selectedDataXBaseMetric, selectedDataXVariant, selectedDataXPhase);
    const normalizedY = normalizeAxisSelection(selectedDataYBaseMetric, selectedDataYVariant, selectedDataYPhase);
    const normalizedY2 = normalizeAxisSelection(selectedDataY2BaseMetric, selectedDataY2Variant, selectedDataY2Phase);

    setSelectedDataXBaseMetric(normalizedX.base || firstBase);
    setSelectedDataXVariant(normalizedX.variant || firstVariant);
    setSelectedDataXPhase(normalizedX.phase);

    setSelectedDataYBaseMetric(normalizedY.base || firstBase);
    setSelectedDataYVariant(normalizedY.variant || firstVariant);
    setSelectedDataYPhase(normalizedY.phase);

    setSelectedDataY2BaseMetric(normalizedY2.base || firstBase);
    setSelectedDataY2Variant(normalizedY2.variant || firstVariant);
    setSelectedDataY2Phase(normalizedY2.phase);

    setExpandedDataMetricBase((previous) => previous || firstBase);
    setExpandedDataMetricVariant((previous) => previous ?? firstVariant);

    setWeightedMetricSelections((previous) => {
      if (previous.length > 0) {
        return previous;
      }

      if (!firstBase) {
        return [];
      }

      return [
        {
          id: `metric-${Date.now()}`,
          baseMetric: firstBase,
          phase: "auto",
          weight: 1,
        },
      ];
    });
  }, [
    dataTagGroups,
    selectedDataXBaseMetric,
    selectedDataXPhase,
    selectedDataXVariant,
    selectedDataY2BaseMetric,
    selectedDataY2Phase,
    selectedDataY2Variant,
    selectedDataYBaseMetric,
    selectedDataYPhase,
    selectedDataYVariant,
  ]);

  React.useEffect(() => {
    setSelectedDataXTag(resolveAxisTag("x"));
  }, [resolveAxisTag]);

  React.useEffect(() => {
    setSelectedDataYTag(resolveAxisTag("y"));
  }, [resolveAxisTag]);

  React.useEffect(() => {
    setSelectedDataYTagSecondary(resolveAxisTag("y2"));
  }, [resolveAxisTag]);

  const extractNumericValue = React.useCallback((entry: JsonEntry, tag: string) => {
    const numericMetrics = extractEntryNumericMetrics(entry);
    return numericMetrics[tag] ?? null;
  }, []);

  const extractTimelineEventTimes = React.useCallback((entry: JsonEntry, tag: string) => {
    const [phase, metric] = tag.split(".");
    if ((phase !== "auto" && phase !== "teleop") || !metric) {
      return [] as number[];
    }

    const phaseBucket = entry[phase];
    if (!phaseBucket || typeof phaseBucket !== "object" || Array.isArray(phaseBucket)) {
      return [] as number[];
    }

    const metricEntry = (phaseBucket as Record<string, unknown>)[metric];
    if (!metricEntry || typeof metricEntry !== "object" || Array.isArray(metricEntry)) {
      return [] as number[];
    }

    const events = (metricEntry as { events?: unknown }).events;
    if (!Array.isArray(events)) {
      return [] as number[];
    }

    return events
      .map((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          return null;
        }
        const time = (event as Record<string, unknown>).time;
        return typeof time === "number" && Number.isFinite(time) ? time : null;
      })
      .filter((time): time is number => time !== null)
      .sort((left, right) => left - right);
  }, []);

  const parseAutoTeleopTag = React.useCallback((tag: string) => {
    if (tag.startsWith("auto.")) {
      return { phase: "auto" as const, base: tag.slice("auto.".length) };
    }
    if (tag.startsWith("teleop.")) {
      return { phase: "teleop" as const, base: tag.slice("teleop.".length) };
    }
    return null;
  }, []);

  const isAutoTeleopPair = React.useCallback(
    (firstTag: string, secondTag: string) => {
      const first = parseAutoTeleopTag(firstTag);
      const second = parseAutoTeleopTag(secondTag);

      if (!first || !second) {
        return false;
      }

      return first.base === second.base && first.phase !== second.phase;
    },
    [parseAutoTeleopTag],
  );

  const dataScatterRows = React.useMemo(() => {
    if (!selectedDataXTag || !selectedDataYTag) {
      return [] as Array<{ x: number; y: number; team: string; matches: number }>;
    }

    const grouped = new Map<string, { xSum: number; xCount: number; ySum: number; yCount: number; matches: number }>();

    for (const entry of jsonEntries) {
      const x = extractNumericValue(entry, selectedDataXTag);
      const y = extractNumericValue(entry, selectedDataYTag);

      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "Unknown";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { xSum: 0, xCount: 0, ySum: 0, yCount: 0, matches: 0 };
      current.matches += 1;

      if (x !== null) {
        current.xSum += x;
        current.xCount += 1;
      }

      if (y !== null) {
        current.ySum += y;
        current.yCount += 1;
      }

      grouped.set(team, current);
    }

    return Array.from(grouped.entries())
      .filter(([, stats]) => stats.xCount > 0 && stats.yCount > 0)
      .map(([team, stats]) => ({
        team,
        x: stats.xSum / stats.xCount,
        y: stats.ySum / stats.yCount,
        matches: stats.matches,
      }))
      .sort((left, right) => right.y - left.y);
  }, [extractNumericValue, jsonEntries, selectedDataXTag, selectedDataYTag]);

  const dataBarRows = React.useMemo(() => {
    if (!selectedDataYTag) {
      return [] as Array<{ team: string; primaryValue: number; secondaryValue: number; totalValue: number }>;
    }

    const grouped = new Map<string, { primarySum: number; primaryCount: number; secondarySum: number; secondaryCount: number }>();

    for (const entry of jsonEntries) {
      const primaryValue = extractNumericValue(entry, selectedDataYTag);
      const secondaryValue = selectedDataYTagSecondary ? extractNumericValue(entry, selectedDataYTagSecondary) : null;

      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "Unknown";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { primarySum: 0, primaryCount: 0, secondarySum: 0, secondaryCount: 0 };

      if (primaryValue !== null) {
        current.primarySum += primaryValue;
        current.primaryCount += 1;
      }

      if (secondaryValue !== null) {
        current.secondarySum += secondaryValue;
        current.secondaryCount += 1;
      }

      grouped.set(team, current);
    }

    return Array.from(grouped.entries())
      .map(([team, stats]) => {
        const primaryAverage = stats.primaryCount > 0 ? stats.primarySum / stats.primaryCount : 0;
        const secondaryAverage = selectedDataYTagSecondary
          ? stats.secondaryCount > 0
            ? stats.secondarySum / stats.secondaryCount
            : 0
          : 0;

        return {
          team,
          primaryValue: primaryAverage,
          secondaryValue: secondaryAverage,
          totalValue: primaryAverage + secondaryAverage,
        };
      })
      .sort((left, right) => right.totalValue - left.totalValue);
  }, [extractNumericValue, jsonEntries, selectedDataYTag, selectedDataYTagSecondary]);

  const weightedDataRows = React.useMemo(() => {
    if (weightedMetricSelections.length === 0) {
      return [] as Array<{ team: string; weightedScore: number; metricBreakdown: Record<string, number> }>;
    }

    const grouped = new Map<string, { weightedSum: number; metricSums: Map<string, { sum: number; count: number; weight: number }> }>();

    for (const entry of jsonEntries) {
      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "Unknown";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { weightedSum: 0, metricSums: new Map<string, { sum: number; count: number; weight: number }>() };

      for (const selection of weightedMetricSelections) {
        const tag = `${selection.phase}.${selection.baseMetric}`;
        const value = extractNumericValue(entry, tag);
        if (value === null) {
          continue;
        }

        const stats = current.metricSums.get(tag) ?? { sum: 0, count: 0, weight: selection.weight };
        stats.sum += value;
        stats.count += 1;
        stats.weight = selection.weight;
        current.metricSums.set(tag, stats);
      }

      grouped.set(team, current);
    }

    const rows = Array.from(grouped.entries()).map(([team, stats]) => {
      const breakdown: Record<string, number> = {};
      let weightedScore = 0;

      for (const [tag, metricStats] of stats.metricSums.entries()) {
        const average = metricStats.count > 0 ? metricStats.sum / metricStats.count : 0;
        const weighted = average * metricStats.weight;
        breakdown[tag] = weighted;
        weightedScore += weighted;
      }

      return {
        team,
        weightedScore,
        metricBreakdown: breakdown,
      };
    });

    return rows.sort((left, right) => right.weightedScore - left.weightedScore);
  }, [extractNumericValue, jsonEntries, weightedMetricSelections]);

  const teamAverages = React.useMemo(() => {
    if (!statsTeam) {
      return [] as Array<{ tag: string; average: number }>;
    }

    const relevantEntries = jsonEntries.filter((entry) => {
      const value = entry.team;
      return typeof value === "string" ? value.trim() === statsTeam : typeof value === "number" ? String(value) === statsTeam : false;
    });

    const totals = new Map<string, { sum: number; count: number }>();

    for (const entry of relevantEntries) {
      const numericMetrics = extractEntryNumericMetrics(entry);

      for (const [tag, numericValue] of Object.entries(numericMetrics)) {
        if (excludedDataTags.has(tag)) {
          continue;
        }

        const current = totals.get(tag) ?? { sum: 0, count: 0 };
        current.sum += numericValue;
        current.count += 1;
        totals.set(tag, current);
      }
    }

    return Array.from(totals.entries())
      .map(([tag, stats]) => ({
        tag,
        average: stats.count > 0 ? stats.sum / stats.count : 0,
      }))
      .filter((item) => {
        if (item.tag === "bricked") {
          return false;
        }

        if (item.tag.endsWith(".accuracy") || item.tag.endsWith(".attempts") || item.tag.endsWith(".fails") || item.tag.endsWith(".successes")) {
          return false;
        }

        if (item.tag.toLowerCase().includes("defensetimeheld") || item.tag.toLowerCase().includes("totaltimeheld")) {
          return false;
        }

        return true;
      })
        .sort((left, right) => compareMetricTags(left.tag, right.tag));
  }, [excludedDataTags, jsonEntries, statsTeam]);

  const selectedTeamMatchCount = React.useMemo(() => {
    if (!statsTeam) {
      return 0;
    }

    return jsonEntries.filter((entry) => {
      const value = entry.team;
      return typeof value === "string" ? value.trim() === statsTeam : typeof value === "number" ? String(value) === statsTeam : false;
    }).length;
  }, [jsonEntries, statsTeam]);

  const selectedTeamEntries = React.useMemo(() => {
    if (!statsTeam) {
      return [] as JsonEntry[];
    }

    return jsonEntries.filter((entry) => {
      const value = entry.team;
      return typeof value === "string" ? value.trim() === statsTeam : typeof value === "number" ? String(value) === statsTeam : false;
    });
  }, [jsonEntries, statsTeam]);

  const selectedTeamAccuracyStats = React.useMemo(() => {
    const stats: Array<{ tag: string; successes: number; fails: number; accuracy: number }> = [];

    for (const entry of selectedTeamEntries) {
      for (const phase of ["auto", "teleop"] as const) {
        const phaseBucket = entry[phase];
        if (!phaseBucket || typeof phaseBucket !== "object" || Array.isArray(phaseBucket)) {
          continue;
        }

        for (const [metric, value] of Object.entries(phaseBucket as Record<string, unknown>)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            continue;
          }

          const item = value as Record<string, unknown>;
          const successes = typeof item.successes === "number" ? item.successes : null;
          const fails = typeof item.fails === "number" ? item.fails : null;
          if (successes === null && fails === null) {
            continue;
          }

          const tag = `${phase}.${metric}`;
          const existing = stats.find((row) => row.tag === tag);
          if (existing) {
            existing.successes += successes ?? 0;
            existing.fails += fails ?? 0;
            const attempts = existing.successes + existing.fails;
            existing.accuracy = attempts > 0 ? existing.successes / attempts : 0;
          } else {
            const nextSuccesses = successes ?? 0;
            const nextFails = fails ?? 0;
            const attempts = nextSuccesses + nextFails;
            stats.push({ tag, successes: nextSuccesses, fails: nextFails, accuracy: attempts > 0 ? nextSuccesses / attempts : 0 });
          }
        }
      }
    }

    return stats.sort((left, right) => right.accuracy - left.accuracy);
  }, [selectedTeamEntries]);

  const selectedTeamToggleStats = React.useMemo(() => {
    const toggleTags = ["bricked"];
    return toggleTags.map((tag) => {
      let trueCount = 0;
      let total = 0;
      for (const entry of selectedTeamEntries) {
        const value = entry[tag];
        if (typeof value === "boolean") {
          total += 1;
          if (value) {
            trueCount += 1;
          }
        }
      }
      return { tag, trueCount, total, rate: total > 0 ? trueCount / total : 0 };
    });
  }, [selectedTeamEntries]);

  const selectedTeamHeldStats = React.useMemo(() => {
    const tags = ["auto.defense", "teleop.defense", "auto.defenseTimeHeld", "teleop.defenseTimeHeld"];
    return tags
      .map((tag) => {
        let sum = 0;
        let count = 0;
        for (const entry of selectedTeamEntries) {
          const value = extractNumericValue(entry, tag);
          if (value !== null) {
            sum += value;
            count += 1;
          }
        }
        return { tag, average: count > 0 ? sum / count : 0, count };
      })
      .filter((item) => item.count > 0);
  }, [extractNumericValue, selectedTeamEntries]);

  const selectedTeamNotes = React.useMemo(() => {
    const rows: Array<{ match: number; scoutType: string; scouter: string; good: string; bad: string; area: string }> = [];

    for (const entry of selectedTeamEntries) {
      const matchValue = typeof entry.match === "number" ? entry.match : typeof entry.match === "string" ? Number(entry.match) : 0;
      const scouter = typeof entry.scouter === "string" ? entry.scouter : "Unknown";
      const ft = Array.isArray(entry.ft) && typeof entry.ft[0] === "number" ? entry.ft[0] : 0;
      rows.push({
        match: Number.isFinite(matchValue) ? matchValue : 0,
        scoutType: ft === 1 ? "qualitative" : ft === 2 ? "pit" : "match",
        scouter,
        good: typeof entry.good === "string" ? entry.good : "",
        bad: typeof entry.bad === "string" ? entry.bad : "",
        area: typeof entry.area === "string" ? entry.area : "",
      });
    }

    return rows.sort((left, right) => right.match - left.match);
  }, [selectedTeamEntries]);

  const filteredSelectedTeamNotes = React.useMemo(() => {
    const term = teamNoteSearch.trim().toLowerCase();
    if (!term) {
      return selectedTeamNotes;
    }

    return selectedTeamNotes.filter((row) => `${row.good} ${row.bad} ${row.area}`.toLowerCase().includes(term));
  }, [selectedTeamNotes, teamNoteSearch]);

  const selectedTeamQualitativeRows = React.useMemo(() => {
    if (!activeTeam) {
      return [] as Array<{
        match: number;
        scouter: string;
        slot: string;
        alliance: string;
        notes: Array<{ field: string; note: string }>;
        generalNotes: Array<{ field: string; note: string }>;
      }>;
    }

    const rows = qualitativeEntries
      .filter((entry) => {
        const teamValue = entry.team;
        const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
        return team === activeTeam;
      })
      .map((entry) => {
        const matchValue = typeof entry.match === "number" ? entry.match : typeof entry.match === "string" ? Number(entry.match) : 0;
        const notes = Array.isArray(entry.notes)
          ? entry.notes
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
              .map((item) => ({
                field: typeof item.field === "string" ? item.field : "note",
                note: typeof item.note === "string" ? item.note : "",
              }))
              .filter((item) => item.note.trim().length > 0)
          : [];

        const generalNotes = Array.isArray(entry.generalNotes)
          ? entry.generalNotes
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
              .map((item) => ({
                field: typeof item.field === "string" ? item.field : "general",
                note: typeof item.note === "string" ? item.note : "",
              }))
              .filter((item) => item.note.trim().length > 0)
          : [];

        return {
          match: Number.isFinite(matchValue) ? matchValue : 0,
          scouter: typeof entry.scouter === "string" && entry.scouter.trim() ? entry.scouter : "Unknown",
          slot: typeof entry.slot === "string" ? entry.slot : "",
          alliance: typeof entry.alliance === "string" ? entry.alliance : "",
          notes,
          generalNotes,
        };
      });

    return rows.sort((left, right) => right.match - left.match);
  }, [activeTeam, qualitativeEntries]);

  const filteredSelectedTeamQualitativeRows = React.useMemo(() => {
    const term = teamQualitativeSearch.trim().toLowerCase();
    if (!term) {
      return selectedTeamQualitativeRows;
    }

    return selectedTeamQualitativeRows.filter((row) => {
      const content = `${row.scouter} ${row.slot} ${row.alliance} ${row.notes.map((item) => `${item.field} ${item.note}`).join(" ")} ${row.generalNotes
        .map((item) => `${item.field} ${item.note}`)
        .join(" ")}`;
      return content.toLowerCase().includes(term);
    });
  }, [selectedTeamQualitativeRows, teamQualitativeSearch]);

  const selectedTeamPitRows = React.useMemo(() => {
    if (!activeTeam) {
      return [] as Array<{
        match: number;
        scouter: string;
        answers: Array<{ questionNumber: number; question: string; answerLabel: string }>;
      }>;
    }

    const rows = pitEntries
      .filter((entry) => {
        const teamValue = entry.team;
        const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
        return team === activeTeam;
      })
      .map((entry) => {
        const matchValue = typeof entry.match === "number" ? entry.match : typeof entry.match === "string" ? Number(entry.match) : 0;
        const answers = Array.isArray(entry.answers)
          ? entry.answers
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
              .map((item) => ({
                questionNumber: typeof item.questionNumber === "number" ? item.questionNumber : 0,
                question: typeof item.question === "string" ? item.question : "Question",
                answerLabel: typeof item.answerLabel === "string" ? item.answerLabel : JSON.stringify(item.answer ?? ""),
              }))
          : [];

        return {
          match: Number.isFinite(matchValue) ? matchValue : 0,
          scouter: typeof entry.scouter === "string" && entry.scouter.trim() ? entry.scouter : "Unknown",
          answers,
        };
      });

    return rows.sort((left, right) => right.match - left.match);
  }, [activeTeam, pitEntries]);

  const filteredSelectedTeamPitRows = React.useMemo(() => {
    const term = teamPitSearch.trim().toLowerCase();
    if (!term) {
      return selectedTeamPitRows;
    }

    return selectedTeamPitRows.filter((row) => {
      const content = `${row.scouter} ${row.answers.map((item) => `${item.question} ${item.answerLabel}`).join(" ")}`;
      return content.toLowerCase().includes(term);
    });
  }, [selectedTeamPitRows, teamPitSearch]);

  const selectedTeamHasEventTracking = React.useMemo(() => {
    for (const entry of selectedTeamEntries) {
      for (const phase of ["auto", "teleop"] as const) {
        const phaseBucket = entry[phase];
        if (!phaseBucket || typeof phaseBucket !== "object" || Array.isArray(phaseBucket)) {
          continue;
        }

        for (const metricValue of Object.values(phaseBucket as Record<string, unknown>)) {
          if (!metricValue || typeof metricValue !== "object" || Array.isArray(metricValue)) {
            continue;
          }

          const events = (metricValue as { events?: unknown }).events;
          if (Array.isArray(events) && events.length > 0) {
            return true;
          }
        }
      }
    }

    return false;
  }, [selectedTeamEntries]);

  const buildTeamSeriesByTag = React.useCallback(
    (team: string) => {
      const series = new Map<string, TeamSeriesPoint[]>();
      if (!team) {
        return series;
      }

      const relevantEntries = jsonEntries.filter((entry) => {
        const value = entry.team;
        return typeof value === "string" ? value.trim() === team : typeof value === "number" ? String(value) === team : false;
      });

      for (let index = 0; index < relevantEntries.length; index += 1) {
        const entry = relevantEntries[index];
        const rawMatch = entry.match;
        let matchNumber = index + 1;

        if (typeof rawMatch === "number" && Number.isFinite(rawMatch)) {
          matchNumber = rawMatch;
        } else if (typeof rawMatch === "string" && rawMatch.trim() !== "") {
          const parsedMatch = Number(rawMatch);
          if (!Number.isNaN(parsedMatch) && Number.isFinite(parsedMatch)) {
            matchNumber = parsedMatch;
          }
        }

        const scouterValue = entry.scouter;
        const scouterName = typeof scouterValue === "string" && scouterValue.trim() ? scouterValue.trim() : "Unknown";

        const numericMetrics = extractEntryNumericMetrics(entry);
        for (const [tag, numericValue] of Object.entries(numericMetrics)) {
          if (excludedDataTags.has(tag)) {
            continue;
          }

          const points = series.get(tag) ?? [];
          points.push({ match: matchNumber, value: numericValue, scouter: scouterName });
          series.set(tag, points);
        }

        for (const cycleMetric of savedCycleMetrics) {
          const starts = extractTimelineEventTimes(entry, cycleMetric.startTag);
          const ends = extractTimelineEventTimes(entry, cycleMetric.endTag);

          if (starts.length === 0 || ends.length === 0) {
            continue;
          }

          const deltas: number[] = [];
          let endIndex = 0;

          for (const startTime of starts) {
            while (endIndex < ends.length && ends[endIndex] <= startTime) {
              endIndex += 1;
            }

            if (endIndex >= ends.length) {
              break;
            }

            deltas.push(ends[endIndex] - startTime);
            endIndex += 1;
          }

          if (deltas.length === 0) {
            continue;
          }

          const averageCycle = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
          const tag = `cycle.${cycleMetric.name}`;
          const points = series.get(tag) ?? [];
          points.push({ match: matchNumber, value: averageCycle, scouter: scouterName });
          series.set(tag, points);
        }
      }

      for (const [tag, points] of series.entries()) {
        points.sort((left, right) => left.match - right.match);
        series.set(tag, points);
      }

      return series;
    },
    [excludedDataTags, extractTimelineEventTimes, jsonEntries, savedCycleMetrics],
  );

  const teamSeriesByTag = React.useMemo(() => {
    return buildTeamSeriesByTag(activeTeam);
  }, [activeTeam, buildTeamSeriesByTag]);

  const availableTeamTags = React.useMemo(() => {
    return Array.from(teamSeriesByTag.keys()).sort(compareMetricTags);
  }, [teamSeriesByTag]);

  React.useEffect(() => {
    setSelectedTeamTag((previous) => {
      if (previous && availableTeamTags.includes(previous)) {
        return previous;
      }
      return availableTeamTags[0] ?? "";
    });
  }, [availableTeamTags]);

  const orderedTeamTags = React.useMemo(() => {
    return [...availableTeamTags].sort(compareMetricTags);
  }, [availableTeamTags]);

  const teamTagGroups = React.useMemo(() => {
    const groups = new Map<string, { base: string; tags: string[] }>();

    for (const tag of orderedTeamTags) {
      const parsed = splitMetricTag(tag);
      if (!parsed) {
        const existing = groups.get(tag) ?? { base: tag, tags: [] };
        existing.tags.push(tag);
        groups.set(tag, existing);
        continue;
      }

      const existing = groups.get(parsed.metric) ?? { base: parsed.metric, tags: [] };
      existing.tags.push(tag);
      groups.set(parsed.metric, existing);
    }

    return Array.from(groups.values()).sort((left, right) => left.base.localeCompare(right.base));
  }, [orderedTeamTags]);

  React.useEffect(() => {
    const parsed = splitMetricTag(selectedTeamTag);
    const fallbackBase = parsed?.metric ?? teamTagGroups[0]?.base ?? "";

    setExpandedTeamMetricBase((previous) => previous || fallbackBase);
  }, [selectedTeamTag, teamTagGroups]);

  const selectedTeamSeries = React.useMemo(() => {
    if (!selectedTeamTag) {
      return [] as TeamSeriesPoint[];
    }

    return teamSeriesByTag.get(selectedTeamTag) ?? [];
  }, [selectedTeamTag, teamSeriesByTag]);

  const compareTeam = React.useMemo(() => compareTeamInput.trim(), [compareTeamInput]);

  const compareTeamSeriesByTag = React.useMemo(() => {
    if (!compareTeam || compareTeam === activeTeam) {
      return new Map<string, TeamSeriesPoint[]>();
    }
    return buildTeamSeriesByTag(compareTeam);
  }, [activeTeam, buildTeamSeriesByTag, compareTeam]);

  const selectedCompareSeries = React.useMemo(() => {
    if (!selectedTeamTag) {
      return [] as TeamSeriesPoint[];
    }
    return compareTeamSeriesByTag.get(selectedTeamTag) ?? [];
  }, [compareTeamSeriesByTag, selectedTeamTag]);

  const targetChartData = React.useMemo(() => {
    const byMatch = new Map<number, TeamChartPoint>();

    for (const point of selectedTeamSeries) {
      byMatch.set(point.match, {
        match: point.match,
        value: point.value,
        compareValue: null,
        scouter: point.scouter,
        compareScouter: "",
      });
    }

    for (const point of selectedCompareSeries) {
      const existing = byMatch.get(point.match);
      if (existing) {
        existing.compareValue = point.value;
        existing.compareScouter = point.scouter;
        byMatch.set(point.match, existing);
      } else {
        byMatch.set(point.match, {
          match: point.match,
          value: null,
          compareValue: point.value,
          scouter: "",
          compareScouter: point.scouter,
        });
      }
    }

    return Array.from(byMatch.values()).sort((left, right) => left.match - right.match);
  }, [selectedCompareSeries, selectedTeamSeries]);

  React.useEffect(() => {
    if (targetChartData.length === 0) {
      setAnimatedChartData([]);
      return;
    }

    const baseline = targetChartData.map((point) => ({
      match: point.match,
      value: typeof point.value === "number" ? 0 : null,
      compareValue: typeof point.compareValue === "number" ? 0 : null,
      scouter: point.scouter,
      compareScouter: point.compareScouter,
    }));
    setAnimatedChartData(baseline);

    const frame = window.requestAnimationFrame(() => {
      setAnimatedChartData(targetChartData);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [targetChartData]);

  React.useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (isTeamGraphFullscreen || isDataGraphFullscreen) {
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDataGraphFullscreen, isTeamGraphFullscreen]);

  React.useEffect(() => {
    if (dataGraphType === "bar") {
      setActiveDataAxis("y");
    }
  }, [dataGraphType]);

  React.useEffect(() => {
    if (!selectedDataYTagSecondary) {
      return;
    }

    if (!allNumericTags.includes(selectedDataYTagSecondary)) {
      setSelectedDataYTagSecondary("");
      return;
    }

    if (!isAutoTeleopPair(selectedDataYTag, selectedDataYTagSecondary)) {
      setSelectedDataYTagSecondary("");
    }
  }, [allNumericTags, isAutoTeleopPair, selectedDataYTag, selectedDataYTagSecondary]);

  const selectableCompareTags = React.useMemo(() => {
    return allNumericTags.filter((tag) => {
      const split = splitMetricTag(tag);
      if (!split) {
        return false;
      }

      const parsed = parseMetricVariant(split.metric);
      return parsed.variant === "value";
    });
  }, [allNumericTags]);

  React.useEffect(() => {
    setCompareMetricTagSelection((previous) => {
      if (previous && selectableCompareTags.includes(previous)) {
        return previous;
      }
      return selectableCompareTags[0] ?? "";
    });
  }, [selectableCompareTags]);

  const updateAllianceTeamInput = React.useCallback((side: AllianceSide, index: number, nextValue: string) => {
    const sanitized = nextValue.replace(/\D+/g, "");

    if (side === "red") {
      setRedAllianceTeams((previous) => {
        const next: [string, string, string] = [...previous] as [string, string, string];
        next[index] = sanitized;
        return next;
      });
      return;
    }

    setBlueAllianceTeams((previous) => {
      const next: [string, string, string] = [...previous] as [string, string, string];
      next[index] = sanitized;
      return next;
    });
  }, []);

  const averageMetricForTeam = React.useCallback(
    (team: string, tag: string): number => {
      if (!team || !tag) {
        return 0;
      }

      let sum = 0;
      let count = 0;

      for (const entry of jsonEntries) {
        const teamValue = entry.team;
        const entryTeam = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
        if (!entryTeam || entryTeam !== team) {
          continue;
        }

        const value = extractNumericValue(entry, tag);
        if (value === null) {
          continue;
        }

        sum += value;
        count += 1;
      }

      return count > 0 ? sum / count : 0;
    },
    [extractNumericValue, jsonEntries],
  );

  const comparePhaseTags = React.useMemo(() => {
    return selectableCompareTags.filter((tag) => tag.startsWith(`${comparePhaseSelection}.`));
  }, [comparePhaseSelection, selectableCompareTags]);

  const scoreTeamForCompare = React.useCallback(
    (team: string): number => {
      if (!team) {
        return 0;
      }

      if (compareScoreMode === "tag") {
        if (!compareMetricTagSelection) {
          return 0;
        }

        const average = averageMetricForTeam(team, compareMetricTagSelection);
        const configWeight = getConfiguredTagPointValue(compareMetricTagSelection);
        return average * compareMetricWeight * configWeight;
      }

      let total = 0;
      for (const tag of comparePhaseTags) {
        const average = averageMetricForTeam(team, tag);
        if (!Number.isFinite(average)) {
          continue;
        }

        total += average * getConfiguredTagPointValue(tag) * comparePhasePointValue;
      }

      return total;
    },
    [
      averageMetricForTeam,
      compareMetricTagSelection,
      compareMetricWeight,
      comparePhasePointValue,
      comparePhaseTags,
      compareScoreMode,
      getConfiguredTagPointValue,
    ],
  );

  const allianceContributionRows = React.useMemo(() => {
    const createRow = (alliance: "Red" | "Blue", teams: [string, string, string]): AllianceContributionRow => {
      const slot1 = scoreTeamForCompare(teams[0]);
      const slot2 = scoreTeamForCompare(teams[1]);
      const slot3 = scoreTeamForCompare(teams[2]);

      return {
        alliance,
        slot1,
        slot2,
        slot3,
        total: slot1 + slot2 + slot3,
        team1: teams[0] || "—",
        team2: teams[1] || "—",
        team3: teams[2] || "—",
      };
    };

    return [createRow("Red", redAllianceTeams), createRow("Blue", blueAllianceTeams)];
  }, [blueAllianceTeams, redAllianceTeams, scoreTeamForCompare]);

  const normalizedDataTeamSearch = React.useMemo(() => dataTeamSearch.trim().toLowerCase(), [dataTeamSearch]);

  const highlightedScatterRows = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return [] as typeof dataScatterRows;
    }
    return dataScatterRows.filter((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataScatterRows, normalizedDataTeamSearch]);

  const regularScatterRows = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return dataScatterRows;
    }
    return dataScatterRows.filter((row) => !row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataScatterRows, normalizedDataTeamSearch]);

  const highlightedBarTeams = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return new Set<string>();
    }
    return new Set(dataBarRows.filter((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch)).map((row) => row.team));
  }, [dataBarRows, normalizedDataTeamSearch]);

  const foundScatterTeam = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return null;
    }
    return highlightedScatterRows[0] ?? null;
  }, [highlightedScatterRows, normalizedDataTeamSearch]);

  const foundBarTeamIndex = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return -1;
    }
    return dataBarRows.findIndex((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataBarRows, normalizedDataTeamSearch]);

  const dataTagActiveAxis = React.useMemo<"x" | "y" | "y2">(() => {
    if (dataGraphType === "bar" && activeDataAxis === "y2") {
      return "y2";
    }

    if (activeDataAxis === "x") {
      return "x";
    }

    return "y";
  }, [activeDataAxis, dataGraphType]);

  const selectedDataBaseForActiveAxis = React.useMemo(() => {
    if (dataTagActiveAxis === "x") {
      return selectedDataXBaseMetric;
    }
    if (dataTagActiveAxis === "y2") {
      return selectedDataY2BaseMetric;
    }
    return selectedDataYBaseMetric;
  }, [dataTagActiveAxis, selectedDataXBaseMetric, selectedDataY2BaseMetric, selectedDataYBaseMetric]);

  const selectedDataVariantForActiveAxis = React.useMemo(() => {
    if (dataTagActiveAxis === "x") {
      return selectedDataXVariant;
    }
    if (dataTagActiveAxis === "y2") {
      return selectedDataY2Variant;
    }
    return selectedDataYVariant;
  }, [dataTagActiveAxis, selectedDataXVariant, selectedDataY2Variant, selectedDataYVariant]);

  const selectedDataPhaseForActiveAxis = React.useMemo(() => {
    if (dataTagActiveAxis === "x") {
      return selectedDataXPhase;
    }
    if (dataTagActiveAxis === "y2") {
      return selectedDataY2Phase;
    }
    return selectedDataYPhase;
  }, [dataTagActiveAxis, selectedDataXPhase, selectedDataY2Phase, selectedDataYPhase]);

  const teamDefaultMatchByTeam = React.useMemo(() => {
    const next = new Map<string, number>();

    for (const entry of jsonEntries) {
      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
      if (!team) {
        continue;
      }

      const matchValue = entry.match;
      const matchNumber = typeof matchValue === "number" ? matchValue : typeof matchValue === "string" ? Number(matchValue) : NaN;
      if (!Number.isFinite(matchNumber)) {
        continue;
      }

      const previous = next.get(team);
      if (previous === undefined || matchNumber > previous) {
        next.set(team, matchNumber);
      }
    }

    return next;
  }, [jsonEntries]);

  const picklistSortedTags = React.useMemo(() => {
    return [...allNumericTags].sort(compareMetricTags);
  }, [allNumericTags]);

  const picklistFilteredTags = React.useMemo(() => {
    const normalized = picklistMetricSearch.trim().toLowerCase();
    if (!normalized) {
      return picklistSortedTags;
    }

    return picklistSortedTags.filter((tag) => formatMetricTagLabel(tag).toLowerCase().includes(normalized));
  }, [picklistMetricSearch, picklistSortedTags]);

  const activePicklist = React.useMemo(() => {
    return picklists.find((picklist) => picklist.id === activePicklistId) ?? picklists[0] ?? null;
  }, [activePicklistId, picklists]);

  const picklistRows = React.useMemo(() => {
    if (!activePicklist) {
      return [] as Array<{ team: string; score: number }>;
    }

    const grouped = new Map<string, { score: number; counts: Map<string, { sum: number; count: number }> }>();

    for (const entry of jsonEntries) {
      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { score: 0, counts: new Map<string, { sum: number; count: number }>() };
      const numericMetrics = extractEntryNumericMetrics(entry);

      for (const [metricTag, weight] of Object.entries(activePicklist.metricWeights)) {
        const value = numericMetrics[metricTag];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          continue;
        }

        const stats = current.counts.get(metricTag) ?? { sum: 0, count: 0 };
        stats.sum += value * weight;
        stats.count += 1;
        current.counts.set(metricTag, stats);
      }

      grouped.set(team, current);
    }

    const rows = Array.from(grouped.entries()).map(([team, stats]) => {
      let score = 0;
      for (const metricStats of stats.counts.values()) {
        score += metricStats.count > 0 ? metricStats.sum / metricStats.count : 0;
      }
      return { team, score };
    });

    const ranked = rows.sort((left, right) => right.score - left.score);
    if (activePicklist.order.length === 0) {
      return ranked;
    }

    const orderIndex = new Map(activePicklist.order.map((team, index) => [team, index]));
    return [...ranked].sort((left, right) => {
      const leftOrder = orderIndex.get(left.team);
      const rightOrder = orderIndex.get(right.team);

      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) {
        return -1;
      }
      if (rightOrder !== undefined) {
        return 1;
      }
      return right.score - left.score;
    });
  }, [activePicklist, jsonEntries]);

  const updateActivePicklist = React.useCallback(
    (updater: (picklist: SavedPicklist) => SavedPicklist) => {
      setPicklists((previous) =>
        previous.map((picklist) => {
          if (picklist.id !== activePicklistId) {
            return picklist;
          }
          return updater(picklist);
        }),
      );
    },
    [activePicklistId],
  );

  const setPicklistMetricWeight = React.useCallback(
    (metricTag: string, nextWeight: number) => {
      updateActivePicklist((picklist) => ({
        ...picklist,
        metricWeights: {
          ...picklist.metricWeights,
          [metricTag]: nextWeight,
        },
      }));
    },
    [updateActivePicklist],
  );

  const togglePicklistStrike = React.useCallback(
    (team: string) => {
      updateActivePicklist((picklist) => {
        const struck = new Set(picklist.struckTeams);
        if (struck.has(team)) {
          struck.delete(team);
        } else {
          struck.add(team);
        }

        return {
          ...picklist,
          struckTeams: Array.from(struck.values()),
        };
      });
    },
    [updateActivePicklist],
  );

  const createNewPicklist = React.useCallback(() => {
    const name = newPicklistName.trim();
    if (!name) {
      return;
    }

    const next: SavedPicklist = {
      id: `picklist-${Date.now()}`,
      name,
      metricWeights: activePicklist?.metricWeights ?? {},
      order: [],
      struckTeams: [],
    };

    setPicklists((previous) => [...previous, next]);
    setActivePicklistId(next.id);
    setNewPicklistName("");
  }, [activePicklist?.metricWeights, newPicklistName]);

  const movePicklistTeam = React.useCallback(
    (fromTeam: string, toTeam: string) => {
      if (fromTeam === toTeam) {
        return;
      }

      updateActivePicklist((picklist) => {
        const currentOrder = picklist.order.length > 0 ? [...picklist.order] : picklistRows.map((row) => row.team);
        const fromIndex = currentOrder.indexOf(fromTeam);
        const toIndex = currentOrder.indexOf(toTeam);

        if (fromIndex < 0 || toIndex < 0) {
          return picklist;
        }

        currentOrder.splice(fromIndex, 1);
        currentOrder.splice(toIndex, 0, fromTeam);

        return {
          ...picklist,
          order: currentOrder,
        };
      });
    },
    [picklistRows, updateActivePicklist],
  );

  const displayedProjects = React.useMemo(() => {
    if (!workspace) {
      return [];
    }

    const term = search.trim().toLowerCase();
    if (!term) {
      return workspace.projects;
    }

    return workspace.projects.filter((project) => project.name.toLowerCase().includes(term));
  }, [search, workspace]);

  const navigateHome = React.useCallback(() => {
    window.location.hash = "#/";
  }, []);

  const navigateProject = React.useCallback((projectId: string) => {
    window.location.hash = buildProjectHash(projectId);
  }, []);

  const navigateTeam = React.useCallback((projectId: string, team: string) => {
    window.location.hash = buildTeamHash(projectId, team);
  }, []);

  const navigateMatch = React.useCallback((projectId: string, team: string, match: number) => {
    window.location.hash = buildMatchHash(projectId, team, match);
  }, []);

  const openMatchFromDataTeam = React.useCallback(
    (team: string) => {
      if (!selectedProject?.id) {
        return;
      }

      const matchNumber = teamDefaultMatchByTeam.get(team);
      if (matchNumber === undefined) {
        return;
      }

      navigateMatch(selectedProject.id, team, matchNumber);
    },
    [navigateMatch, selectedProject?.id, teamDefaultMatchByTeam],
  );

  const navigateViewer = React.useCallback((project?: WorkspaceProject) => {
    window.location.hash = buildViewerHash(project);
  }, []);

  const handleCreateProject = React.useCallback(async () => {
    const name = createProjectName.trim();
    if (!name) {
      setWorkspaceError("Project name is required.");
      return;
    }

    const contentHash = createProjectContentHash.trim();
    if (!contentHash) {
      setWorkspaceError("Content hash is required to create a project.");
      return;
    }

    setIsCreatingProject(true);

    try {
      const validation = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
        contentHash,
        expectedScoutType: "match",
      });

      if (!validation.valid) {
        setWorkspaceError(`Could not create project: ${validation.message}`);
        return;
      }

      const project = await invoke<WorkspaceProject>("create_goonhq_project", { name });

      const createdConfig: ProjectConfig = {
        matchContentHash: contentHash,
        qualitativeContentHash: "",
        pitContentHash: "",
        tagPointValues: {},
        backgroundImage: validation.background_image ?? null,
        backgroundLocation: validation.background_location ?? null,
        fieldMapping: validation.field_mapping ?? null,
        layoutPayload: validation.payload ?? null,
      };

      await invoke("save_project_config", {
        projectId: project.id,
        config: createdConfig,
      });

      const persistedConfig = await invoke<ProjectConfig>("get_project_config", {
        projectId: project.id,
      });

      if ((persistedConfig.matchContentHash ?? "").trim() !== contentHash) {
        throw new Error("Project config did not persist match content hash.");
      }

      setProjectConfig(persistedConfig);
      if (isScoutingFieldMapping(persistedConfig.fieldMapping)) {
        setDecodeFieldMapping(persistedConfig.fieldMapping);
      }

      await refreshWorkspace();
      setIsCreateDialogOpen(false);
      setCreateProjectName("Untitled Project");
      setCreateProjectContentHash("");
      window.location.hash = buildProjectHash(project.id);
    } catch (error) {
      setWorkspaceError(`Could not create project: ${String(error)}`);
    } finally {
      setIsCreatingProject(false);
    }
  }, [createProjectContentHash, createProjectName, refreshWorkspace]);

  const validateAndSaveConfigHash = React.useCallback(
    async (kind: "match" | "qualitative" | "pit") => {
      if (!selectedProject) {
        return;
      }

      const hashValue =
        kind === "match"
          ? configMatchHashDraft.trim()
          : kind === "qualitative"
            ? configQualitativeHashDraft.trim()
            : configPitHashDraft.trim();

      const nextConfigWithDraftHash: ProjectConfig = {
        ...projectConfig,
        matchContentHash: kind === "match" ? hashValue : projectConfig.matchContentHash,
        qualitativeContentHash: kind === "qualitative" ? hashValue : projectConfig.qualitativeContentHash,
        pitContentHash: kind === "pit" ? hashValue : projectConfig.pitContentHash,
      };

      setIsSavingConfig(true);

      try {
        if (hashValue.length > 0) {
          const validation = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
            contentHash: hashValue,
            expectedScoutType: kind,
          });

          if (!validation.valid) {
            setConfigStatus(validation.message);
            return;
          }

          const nextConfig: ProjectConfig = {
            ...nextConfigWithDraftHash,
            backgroundImage: validation.background_image ?? projectConfig.backgroundImage ?? null,
            backgroundLocation: validation.background_location ?? projectConfig.backgroundLocation ?? null,
            fieldMapping: validation.field_mapping ?? projectConfig.fieldMapping ?? null,
            layoutPayload: validation.payload ?? projectConfig.layoutPayload ?? null,
          };

          await invoke("save_project_config", {
            projectId: selectedProject.id,
            config: nextConfig,
          });

          setProjectConfig(nextConfig);
          setConfigStatus(`${kind} hash validated and saved.`);
          return;
        }

        await invoke("save_project_config", {
          projectId: selectedProject.id,
          config: nextConfigWithDraftHash,
        });
        setProjectConfig(nextConfigWithDraftHash);
        setConfigStatus(`${kind} hash cleared and saved.`);
      } catch (error) {
        setConfigStatus(`Unable to save ${kind} hash: ${String(error)}`);
      } finally {
        setIsSavingConfig(false);
      }
    },
    [configMatchHashDraft, configPitHashDraft, configQualitativeHashDraft, projectConfig, selectedProject],
  );

  const setTagPointValue = React.useCallback((baseMetric: string, rawValue: string) => {
    const parsed = Number(rawValue);
    const safeValue = Number.isFinite(parsed) ? parsed : 0;

    setProjectConfig((previous) => ({
      ...previous,
      tagPointValues: {
        ...(previous.tagPointValues ?? {}),
        [baseMetric]: safeValue,
      },
    }));
  }, []);

  const saveTagPointValues = React.useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsSavingTagPoints(true);

    try {
      await invoke("save_project_config", {
        projectId: selectedProject.id,
        config: projectConfig,
      });

      setConfigStatus("Tag point values saved.");
    } catch (error) {
      setConfigStatus(`Unable to save tag point values: ${String(error)}`);
    } finally {
      setIsSavingTagPoints(false);
    }
  }, [projectConfig, selectedProject]);

  const handleSetRootFolder = React.useCallback(async () => {
    if (isSettingRootFolder) {
      return;
    }

    setIsSettingRootFolder(true);

    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (typeof selected !== "string") {
        return;
      }

      await invoke("set_workspace_root", {
        rootPath: selected,
      });

      await refreshWorkspace();
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(`Unable to set root folder: ${String(error)}`);
    } finally {
      setIsSettingRootFolder(false);
    }
  }, [isSettingRootFolder, refreshWorkspace]);

  const handleDebugValidateHash = React.useCallback(async () => {
    const hash = debugContentHash.trim();
    if (!hash) {
      setDebugMessage("Enter a content hash first.");
      setDebugResult(null);
      return;
    }

    setIsRunningDebugValidation(true);
    setDebugMessage("Validating hash with backend...");

    try {
      const result = await invoke<ContentHashValidationResult>("validate_field_config_content_hash", {
        contentHash: hash,
        expectedScoutType: debugScoutType,
      });

      setDebugResult(result);
      setDebugMessage(result.valid ? "Backend connection OK. Hash is valid." : `Backend reachable. ${result.message}`);
    } catch (error) {
      setDebugResult(null);
      setDebugMessage(`Backend validation failed: ${String(error)}`);
    } finally {
      setIsRunningDebugValidation(false);
    }
  }, [debugContentHash, debugScoutType]);

  const parseEntryMatchNumber = React.useCallback((entry: JsonEntry): number | null => {
    const matchValue = entry.match;
    if (typeof matchValue === "number" && Number.isFinite(matchValue)) {
      return matchValue;
    }
    if (typeof matchValue === "string" && matchValue.trim() !== "") {
      const parsed = Number(matchValue);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }, []);

  const matchEntriesForRoute = React.useMemo(() => {
    if (route.kind !== "match") {
      return [] as JsonEntry[];
    }

    return jsonEntries.filter((entry) => parseEntryMatchNumber(entry) === route.match);
  }, [jsonEntries, parseEntryMatchNumber, route]);

  const selectedMatchEntry = React.useMemo(() => {
    if (route.kind !== "match") {
      return null;
    }

    return (
      matchEntriesForRoute.find((entry) => {
        const teamValue = entry.team;
        const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
        return team === route.team;
      }) ?? null
    );
  }, [matchEntriesForRoute, route]);

  const otherMatchTeams = React.useMemo(() => {
    if (route.kind !== "match") {
      return [] as string[];
    }

    const teams = new Set<string>();
    for (const entry of matchEntriesForRoute) {
      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "";
      if (!team || team === route.team) {
        continue;
      }
      teams.add(team);
    }

    return Array.from(teams).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }, [matchEntriesForRoute, route]);

  const selectedMatchTimelineEvents = React.useMemo(() => {
    if (!selectedMatchEntry) {
      return [] as Array<{ phase: "auto" | "teleop"; metric: string; time: number; valueLabel: string }>;
    }

    const timelineEvents: Array<{ phase: "auto" | "teleop"; metric: string; time: number; valueLabel: string }> = [];

    for (const phase of ["auto", "teleop"] as const) {
      const bucket = selectedMatchEntry[phase];
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
        continue;
      }

      for (const [metric, metricData] of Object.entries(bucket as Record<string, unknown>)) {
        if (!metricData || typeof metricData !== "object" || Array.isArray(metricData)) {
          continue;
        }

        const events = (metricData as { events?: unknown }).events;
        if (!Array.isArray(events)) {
          continue;
        }

        for (const event of events) {
          if (!event || typeof event !== "object" || Array.isArray(event)) {
            continue;
          }

          const eventObject = event as Record<string, unknown>;
          const timeValue = eventObject.time;
          if (typeof timeValue !== "number" || !Number.isFinite(timeValue)) {
            continue;
          }

          const valueLabel =
            typeof eventObject.value === "number"
              ? `+${eventObject.value}${typeof eventObject.result === "string" ? ` (${eventObject.result})` : ""}`
              : typeof eventObject.duration === "number"
                ? `${eventObject.duration.toFixed(2)}s hold`
                : "event";

          timelineEvents.push({
            phase,
            metric,
            time: timeValue,
            valueLabel,
          });
        }
      }
    }

    return timelineEvents.sort((left, right) => left.time - right.time);
  }, [selectedMatchEntry]);

  const selectedMatchGeneralQualitativeNotes = React.useMemo(() => {
    if (route.kind !== "match") {
      return [] as Array<{ team: string; scouter: string; notes: Array<{ field: string; note: string }> }>;
    }

    const rows = qualitativeEntries
      .filter((entry) => {
        const matchValue = typeof entry.match === "number" ? entry.match : typeof entry.match === "string" ? Number(entry.match) : NaN;
        return Number.isFinite(matchValue) && Number(matchValue) === route.match;
      })
      .map((entry) => {
        const generalNotes = Array.isArray(entry.generalNotes)
          ? entry.generalNotes
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
              .map((item) => ({
                field: typeof item.field === "string" ? item.field : "general",
                note: typeof item.note === "string" ? item.note : "",
              }))
              .filter((item) => item.note.trim().length > 0)
          : [];

        return {
          team: typeof entry.team === "string" ? entry.team : typeof entry.team === "number" ? String(entry.team) : "Unknown",
          scouter: typeof entry.scouter === "string" && entry.scouter.trim() ? entry.scouter : "Unknown",
          notes: generalNotes,
        };
      })
      .filter((row) => row.notes.length > 0);

    return rows.sort((left, right) => left.team.localeCompare(right.team, undefined, { numeric: true }));
  }, [qualitativeEntries, route]);

  const filteredMatchGeneralQualitativeNotes = React.useMemo(() => {
    const term = matchGeneralSearch.trim().toLowerCase();
    if (!term) {
      return selectedMatchGeneralQualitativeNotes;
    }

    return selectedMatchGeneralQualitativeNotes.filter((row) => {
      const content = `${row.team} ${row.scouter} ${row.notes.map((item) => `${item.field} ${item.note}`).join(" ")}`;
      return content.toLowerCase().includes(term);
    });
  }, [matchGeneralSearch, selectedMatchGeneralQualitativeNotes]);

  const viewerPath = route.kind === "viewer" ? selectedProject?.json_file_path ?? "" : "";

  if (route.kind === "viewer") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
            <Button type="button" variant="secondary" size="sm" onClick={navigateHome}>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Button>
            {selectedProject ? (
              <Button type="button" variant="outline" size="sm" onClick={() => navigateProject(selectedProject.id)}>
                <Folder className="mr-2 h-4 w-4" />
                {selectedProject.name}
              </Button>
            ) : null}
          </div>
          <div className="text-sm text-white/65">JSON Viewer</div>
        </header>

        <JsonViewerPage
          initialPath={viewerPath}
          projectId={selectedProject?.id ?? route.projectId}
          fieldMapping={decodeFieldMapping}
          qualitativeContentHash={projectConfig.qualitativeContentHash}
          pitContentHash={projectConfig.pitContentHash}
        />
      </div>
    );
  }

  if (route.kind === "team") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
            <Button type="button" variant="secondary" size="sm" onClick={navigateHome}>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Button>
            {selectedProject ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setProjectSection("teams");
                  navigateProject(selectedProject.id);
                }}
              >
                <Folder className="mr-2 h-4 w-4" />
                {selectedProject.name}
              </Button>
            ) : null}
          </div>
          <div className="text-sm text-white/65">Team Details</div>
        </header>

        <main className="p-4 md:p-6">
          {!selectedProject ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">Project not found.</div>
          ) : (
            <div
              className={`space-y-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 md:p-6 ${
                isTeamGraphFullscreen ? "" : "backdrop-blur"
              }`}
            >
              <h1 className="text-3xl font-semibold tracking-tight">
                Team <span className="text-white">{activeTeam}</span>
              </h1>
              <p className="text-white/75">
                Project: <span className="font-semibold text-white">{selectedProject.name}</span> • Matches: {selectedTeamMatchCount}
              </p>

              {isLoadingIndex ? (
                <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading team stats...</div>
              ) : indexError ? (
                <p className="text-sm text-red-300">{indexError}</p>
              ) : teamAverages.length === 0 ? (
                <p className="text-sm text-white/60">No numeric tags available for averages.</p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {teamAverages.map((item) => (
                    <div key={item.tag} className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                      <p className="text-xs uppercase tracking-wide text-white/55">{formatMetricTagLabel(item.tag)}</p>
                      <p className="mt-2 text-2xl font-semibold text-white">{item.average.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className={isTeamGraphFullscreen ? "fixed inset-0 z-[200] overflow-y-auto bg-slate-950 p-4 md:p-6" : ""}>
                <div className="mb-3 flex items-center justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"
                    onClick={() => setIsTeamGraphFullscreen((current) => !current)}
                  >
                    {isTeamGraphFullscreen ? "Exit Full Screen" : "Full Screen"}
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                <aside className="rounded-xl border border-white/10 bg-slate-900/50 p-3 xl:col-span-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Data Tags</p>
                  <p className="mb-3 text-xs text-white/50">Choose a stat, then choose auto or teleop.</p>

                  {teamTagGroups.length === 0 ? (
                    <p className="text-sm text-white/60">No numeric tags available.</p>
                  ) : (
                    <div className="max-h-[calc(100dvh-360px)] space-y-2 overflow-y-auto pr-1">
                      {teamTagGroups.map((group) => {
                        const isExpanded = expandedTeamMetricBase === group.base;
                        const selectedInGroup = group.tags.includes(selectedTeamTag);

                        return (
                          <div key={group.base} className="rounded-lg border border-white/15 bg-slate-900/70 p-2">
                            <button
                              type="button"
                              onClick={() => setExpandedTeamMetricBase((previous) => (previous === group.base ? "" : group.base))}
                              className={`w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition ${
                                selectedInGroup
                                  ? "border-blue-400/70 bg-blue-600/20 text-white"
                                  : "border-white/15 bg-slate-900 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                              }`}
                            >
                              {group.base}
                            </button>

                            {isExpanded ? (
                              <div className="mt-2 grid grid-cols-2 gap-2">
                                {group.tags.sort(compareMetricTags).map((tag) => {
                                  const parsed = splitMetricTag(tag);
                                  const phaseLabel = parsed ? parsed.phase : tag;
                                  const selected = selectedTeamTag === tag;

                                  return (
                                    <button
                                      key={tag}
                                      type="button"
                                      onClick={() => setSelectedTeamTag(tag)}
                                      className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                                        selected
                                          ? "border-blue-400/70 bg-blue-600/20 text-white"
                                          : "border-white/15 bg-slate-950/70 text-white/85 hover:border-blue-400/60 hover:bg-blue-600/20"
                                      }`}
                                    >
                                      {phaseLabel}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </aside>

                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-9">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-white/75">
                        Match vs <span className="font-semibold text-white">{selectedTeamTag ? formatMetricTagLabel(selectedTeamTag) : "Tag"}</span>
                      </p>
                      <p className="text-xs text-white/50">X: Match • Y: Selected Tag Value</p>
                      {compareTeam && compareTeam !== activeTeam ? (
                        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-white/70">
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-400" />
                            <span>Team {activeTeam}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
                            <span>Team {compareTeam}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-white/60">Compare team</p>
                      <Input
                        value={compareTeamInput}
                        onChange={(event) => setCompareTeamInput(event.currentTarget.value)}
                        placeholder="Team #"
                        className="h-9 w-32 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                      />
                    </div>
                  </div>

                  {selectedTeamTag && animatedChartData.length > 0 ? (
                    <div className={isTeamGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[260px] w-full" : "h-[420px] w-full"}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={animatedChartData}
                          margin={{ top: 12, right: 20, left: 0, bottom: 8 }}
                          onClick={(chartState) => {
                            const payload = (chartState as { activePayload?: Array<{ payload?: TeamChartPoint }> } | undefined)?.activePayload?.[0]?.payload;
                            if (!payload) {
                              return;
                            }

                            if (route.kind === "team") {
                              navigateMatch(route.projectId, route.team, payload.match);
                            }
                          }}
                        >
                          <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="match"
                            type="number"
                            domain={["dataMin", "dataMax"]}
                            tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                            allowDecimals={false}
                          />
                          <YAxis
                            type="number"
                            domain={["auto", "auto"]}
                            tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                            width={60}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "rgba(2,6,23,0.95)",
                              border: "1px solid rgba(255,255,255,0.15)",
                              borderRadius: "0.75rem",
                              color: "white",
                            }}
                            formatter={(value, name, item) => {
                              const numeric = typeof value === "number" ? value : Number(value);
                              const entry = item.payload as TeamChartPoint;
                              const baseLabel = selectedTeamTag ? formatMetricTagLabel(selectedTeamTag) : "Tag";
                              const tagLabel = name === "compareValue" ? `${baseLabel} (Compare)` : baseLabel;
                              const scouter = name === "compareValue" ? entry.compareScouter || "Unknown" : entry.scouter || "Unknown";
                              const valueLabel = Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
                              return [`${valueLabel} • Scouter: ${scouter}`, tagLabel];
                            }}
                            labelFormatter={(label) => `Match ${label}`}
                          />
                          <Line
                            type="linear"
                            dataKey="value"
                            connectNulls
                            stroke="#60a5fa"
                            strokeWidth={3}
                            dot={{ r: 3, fill: "#93c5fd", stroke: "#60a5fa" }}
                            activeDot={{ r: 5 }}
                            isAnimationActive
                            animationDuration={520}
                            animationEasing="ease-out"
                          />
                          {compareTeam && compareTeam !== activeTeam ? (
                            <Line
                              type="linear"
                              dataKey="compareValue"
                              connectNulls
                              stroke="#f59e0b"
                              strokeWidth={3}
                              dot={{ r: 3, fill: "#fbbf24", stroke: "#f59e0b" }}
                              activeDot={{ r: 5 }}
                              isAnimationActive
                              animationDuration={520}
                              animationEasing="ease-out"
                            />
                          ) : null}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className={`${isTeamGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[260px]" : "h-[420px]"} flex items-center justify-center rounded-lg border border-white/10 bg-slate-950/50 text-sm text-white/60`}>
                      Select a tag to view the graph.
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/50 p-4">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                    <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Accuracy Metrics</p>
                    <div className="max-h-40 space-y-2 overflow-y-auto pr-1 text-xs">
                      {selectedTeamAccuracyStats.length === 0 ? (
                        <p className="text-white/50">No success/fail metrics found.</p>
                      ) : (
                        selectedTeamAccuracyStats.map((item) => (
                          <div key={`acc-team-route-${item.tag}`}>
                            <p className="text-white/75">{formatMetricTagLabel(item.tag)}</p>
                            <div className="mt-1 h-2 w-full overflow-hidden rounded bg-white/10">
                              <div className="h-full bg-emerald-400" style={{ width: `${Math.max(0, Math.min(100, item.accuracy * 100))}%` }} />
                            </div>
                            <p className="mt-1 text-white/55">{(item.accuracy * 100).toFixed(1)}% • S {item.successes} / F {item.fails}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                    <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Toggle Frequency</p>
                    <div className="space-y-2 text-xs">
                      {selectedTeamToggleStats.map((item) => (
                        <div key={`toggle-team-route-${item.tag}`}>
                          <p className="text-white/75">{item.tag}</p>
                          <div className="mt-1 h-2 w-full overflow-hidden rounded bg-white/10">
                            <div className="h-full bg-amber-400" style={{ width: `${Math.max(0, Math.min(100, item.rate * 100))}%` }} />
                          </div>
                          <p className="mt-1 text-white/55">{(item.rate * 100).toFixed(1)}% true ({item.trueCount}/{item.total})</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                    <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Held Time Per Match</p>
                    <div className="space-y-2 text-xs">
                      {selectedTeamHeldStats.length === 0 ? (
                        <p className="text-white/50">No hold-time metrics found.</p>
                      ) : (
                        selectedTeamHeldStats.map((item) => (
                          <div key={`held-team-route-${item.tag}`} className="flex items-center justify-between text-white/75">
                            <span>{formatMetricTagLabel(item.tag)}</span>
                            <span>{item.average.toFixed(2)}s</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {selectedTeamHasEventTracking ? (
                  <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                    <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Cycle Time Builder (event-tracking only)</p>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                      <Input value={cycleMetricName} onChange={(event) => setCycleMetricName(event.currentTarget.value)} placeholder="Metric name" className="h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
                      <Input value={cycleStartTag} onChange={(event) => setCycleStartTag(event.currentTarget.value)} placeholder="Start metric" className="h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
                      <Input value={cycleEndTag} onChange={(event) => setCycleEndTag(event.currentTarget.value)} placeholder="End metric" className="h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
                      <Button
                        type="button"
                        className="bg-blue-600 text-white hover:bg-blue-500"
                        onClick={() => {
                          const name = cycleMetricName.trim();
                          const start = cycleStartTag.trim();
                          const end = cycleEndTag.trim();
                          if (!name || !start || !end) {
                            return;
                          }
                          setSavedCycleMetrics((previous) => [
                            ...previous,
                            {
                              id: `cycle-${Date.now()}-${previous.length}`,
                              name,
                              startTag: start,
                              endTag: end,
                            },
                          ]);
                          setCycleMetricName("");
                          setCycleStartTag("");
                          setCycleEndTag("");
                        }}
                      >
                        Save Cycle Metric
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                  <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Matches</p>
                  <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                    {selectedTeamEntries.map((entry, index) => {
                      const matchValue = typeof entry.match === "number" ? entry.match : typeof entry.match === "string" ? Number(entry.match) : index + 1;
                      const scouterValue = typeof entry.scouter === "string" ? entry.scouter : "Unknown";
                      return (
                        <Button
                          key={`match-card-team-route-${activeTeam}-${matchValue}-${index}`}
                          type="button"
                          variant="outline"
                          className="w-full justify-between border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"
                          onClick={() => navigateMatch(selectedProject.id, activeTeam, Number(matchValue))}
                        >
                          <span>Match {Number(matchValue)}</span>
                          <span className="text-xs text-white/60">{scouterValue}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                  <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Match Scouters</p>
                  <Input value={teamNoteSearch} onChange={(event) => setTeamNoteSearch(event.currentTarget.value)} placeholder="Search match notes..." className="mb-2 h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
                  <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                    {filteredSelectedTeamNotes.map((note, index) => (
                      <button
                        key={`note-team-route-${note.match}-${index}`}
                        type="button"
                        onClick={() => navigateMatch(selectedProject.id, activeTeam, note.match)}
                        className="w-full rounded border border-white/10 bg-slate-900/50 p-2 text-left text-xs text-white/75 transition hover:border-blue-400/50 hover:bg-blue-600/10"
                      >
                        <p className="font-semibold text-white">Match {note.match} • {note.scoutType} • {note.scouter}</p>
                        <p className="mt-1">Good: {highlightSearchTerm(note.good || "—", teamNoteSearch)}</p>
                        <p>Bad: {highlightSearchTerm(note.bad || "—", teamNoteSearch)}</p>
                        <p>Area: {highlightSearchTerm(note.area || "—", teamNoteSearch)}</p>
                      </button>
                    ))}
                    {filteredSelectedTeamNotes.length === 0 ? <p className="text-xs text-white/50">No match scouter notes found.</p> : null}
                  </div>
                </div>

                <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                  <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Qualitative Scouters</p>
                  <Input
                    value={teamQualitativeSearch}
                    onChange={(event) => setTeamQualitativeSearch(event.currentTarget.value)}
                    placeholder="Search qualitative notes..."
                    className="mb-2 h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                  />
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {filteredSelectedTeamQualitativeRows.map((row, index) => (
                      <div key={`qual-team-route-${row.match}-${row.scouter}-${index}`} className="rounded border border-white/10 bg-slate-900/50 p-2 text-xs text-white/80">
                        <p className="font-semibold text-white">Match {row.match} • {row.scouter} • {row.alliance.toUpperCase()} {row.slot.toUpperCase()}</p>
                        {row.notes.map((item, noteIndex) => (
                          <p key={`qual-note-${index}-${noteIndex}`} className="mt-1">
                            <span className="text-white/60">{item.field}: </span>
                            {highlightSearchTerm(item.note || "—", teamQualitativeSearch)}
                          </p>
                        ))}
                        {row.generalNotes.length > 0 ? <p className="mt-2 text-[11px] uppercase tracking-wide text-white/45">General</p> : null}
                        {row.generalNotes.map((item, noteIndex) => (
                          <p key={`qual-general-${index}-${noteIndex}`}>
                            <span className="text-white/60">{item.field}: </span>
                            {highlightSearchTerm(item.note || "—", teamQualitativeSearch)}
                          </p>
                        ))}
                      </div>
                    ))}
                    {filteredSelectedTeamQualitativeRows.length === 0 ? <p className="text-xs text-white/50">No qualitative notes found for this team.</p> : null}
                  </div>
                </div>

                <div className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                  <p className="mb-2 text-xs uppercase tracking-wide text-white/55">Pit Scouts</p>
                  <Input
                    value={teamPitSearch}
                    onChange={(event) => setTeamPitSearch(event.currentTarget.value)}
                    placeholder="Search pit responses..."
                    className="mb-2 h-9 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                  />
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {filteredSelectedTeamPitRows.map((row, index) => (
                      <div key={`pit-team-route-${row.match}-${row.scouter}-${index}`} className="rounded border border-white/10 bg-slate-900/55 p-2 text-xs text-white/80">
                        <p className="mb-2 font-semibold text-white">Match {row.match} • {row.scouter}</p>
                        <div className="space-y-1">
                          {row.answers.map((answer, answerIndex) => (
                            <div key={`pit-answer-${index}-${answerIndex}`} className="flex items-start justify-between gap-3 border-b border-white/5 pb-1 last:border-b-0 last:pb-0">
                              <p className="text-white/65">{answer.questionNumber}. {answer.question}</p>
                              <p className="max-w-[45%] text-right text-white">{highlightSearchTerm(answer.answerLabel || "—", teamPitSearch)}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {filteredSelectedTeamPitRows.length === 0 ? <p className="text-xs text-white/50">No pit responses found for this team.</p> : null}
                  </div>
                </div>
              </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  if (route.kind === "match") {
    const notesSearch = (matchGeneralSearch || "").trim().toLowerCase();
    const goodText = typeof selectedMatchEntry?.good === "string" ? selectedMatchEntry.good : "";
    const badText = typeof selectedMatchEntry?.bad === "string" ? selectedMatchEntry.bad : "";
    const areaText = typeof selectedMatchEntry?.area === "string" ? selectedMatchEntry.area : "";
    const noteBlocks = [goodText, badText, areaText].filter((value) => value.trim().length > 0);
    const noteMatchCount = notesSearch
      ? noteBlocks.filter((value) => value.toLowerCase().includes(notesSearch)).length
      : noteBlocks.length;

    const startPosition = Array.isArray(selectedMatchEntry?.p) ? selectedMatchEntry.p : null;
    const normalizedStartX = startPosition && typeof startPosition[0] === "number" ? Math.min(Math.max(startPosition[0], 0), 1) : null;
    const normalizedStartY = startPosition && typeof startPosition[1] === "number" ? Math.min(Math.max(startPosition[1], 0), 1) : null;
    const layoutPayload = parseLayoutPayload(projectConfig.layoutPayload);

    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
            <Button type="button" variant="secondary" size="sm" onClick={navigateHome}>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => navigateTeam(route.projectId, route.team)}>
              <Folder className="mr-2 h-4 w-4" />
              Team {route.team}
            </Button>
          </div>
          <div className="text-sm text-white/65">Match {route.match}</div>
        </header>

        <main className="space-y-4 p-4 md:p-6">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 xl:col-span-7">
              <h1 className="text-2xl font-semibold tracking-tight">Team {route.team} • Match {route.match}</h1>
              <p className="text-sm text-white/70">Scouter: {typeof selectedMatchEntry?.scouter === "string" && selectedMatchEntry.scouter.trim() ? selectedMatchEntry.scouter : "Unknown"}</p>

              <div className="relative h-[340px] overflow-hidden rounded-xl border border-white/10 bg-slate-900/60">
                {projectConfig.backgroundImage && layoutPayload ? (
                  <MiniScoutField payloadObject={layoutPayload} fieldImageUrl={projectConfig.backgroundImage} className="h-full w-full" />
                ) : projectConfig.backgroundImage ? (
                  <img src={projectConfig.backgroundImage} alt="Field" className="h-full w-full object-contain" />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-white/50">No background image available in project config.</div>
                )}

                {normalizedStartX !== null && normalizedStartY !== null ? (
                  <div
                    className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-blue-500"
                    style={{ left: `${normalizedStartX * 100}%`, top: `${normalizedStartY * 100}%` }}
                    title="Robot start position"
                  />
                ) : null}
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold text-white">Scout Button Timeline</p>
                {selectedMatchTimelineEvents.length === 0 ? (
                  <div className="rounded-lg border border-white/10 bg-slate-900/50 px-3 py-2 text-xs text-white/60">No event-time-tracking timeline available for this match record.</div>
                ) : (
                  <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
                    {selectedMatchTimelineEvents.map((event, index) => (
                      <div key={`${event.phase}-${event.metric}-${event.time}-${index}`} className="rounded-lg border border-white/10 bg-slate-900/50 px-3 py-2 text-xs text-white/80">
                        <span className="font-semibold text-white">{event.time.toFixed(2)}s</span> • {event.metric} ({event.phase}) • {event.valueLabel}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 xl:col-span-5">
              <h2 className="text-lg font-semibold text-white">Notes + Qualitative</h2>
              <Input
                value={matchGeneralSearch}
                onChange={(event) => setMatchGeneralSearch(event.currentTarget.value)}
                placeholder="Find note keywords..."
                className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
              />
              <p className="text-xs text-white/60">Matching note blocks: {noteMatchCount}</p>

              <div className="space-y-2">
                <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3">
                  <p className="text-xs uppercase text-white/55">Good</p>
                  <p className="mt-1 text-sm text-white/80">{goodText || "—"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3">
                  <p className="text-xs uppercase text-white/55">Bad</p>
                  <p className="mt-1 text-sm text-white/80">{badText || "—"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3">
                  <p className="text-xs uppercase text-white/55">Area</p>
                  <p className="mt-1 text-sm text-white/80">{areaText || "—"}</p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold text-white">Other Robots In This Match</p>
                {otherMatchTeams.length === 0 ? (
                  <div className="rounded-lg border border-white/10 bg-slate-900/50 px-3 py-2 text-xs text-white/60">No additional teams found in loaded records for this match.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {otherMatchTeams.map((team) => (
                      <Button key={team} type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => navigateTeam(route.projectId, team)}>
                        Team {team}
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3">
                <p className="mb-2 text-sm font-semibold text-white">General Qualitative Notes</p>
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1 text-xs text-white/80">
                  {filteredMatchGeneralQualitativeNotes.length === 0 ? (
                    <p className="text-white/55">No general qualitative notes found for this match.</p>
                  ) : (
                    filteredMatchGeneralQualitativeNotes.map((row, index) => (
                      <div key={`match-general-${row.team}-${row.scouter}-${index}`} className="rounded border border-white/10 bg-slate-950/60 p-2">
                        <p className="font-semibold text-white">Team {row.team} • {row.scouter}</p>
                        {row.notes.map((item, noteIndex) => (
                          <p key={`match-general-note-${index}-${noteIndex}`} className="mt-1">
                            <span className="text-white/55">{item.field}: </span>
                            {highlightSearchTerm(item.note || "—", matchGeneralSearch)}
                          </p>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    );
  }

  if (route.kind === "project") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
          <div className="flex items-center gap-3">
            <Button type="button" className="h-10 rounded-xl bg-blue-600 px-5 text-white hover:bg-blue-500" onClick={() => setIsCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
            <Button type="button" variant="outline" className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800" onClick={() => void refreshWorkspace()}>
              <Upload className="mr-2 h-4 w-4" />
              Upload
            </Button>
          </div>
        </header>

        <main className="grid h-[calc(100vh-73px)] grid-cols-1 items-start gap-4 p-4 md:grid-cols-12">
          <aside className="flex h-full flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-3 xl:col-span-2">
            <button
              type="button"
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "overview" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("overview")}
            >
              <Home className="h-4 w-4" />
              Overview
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "config" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("config")}
            >
              <Settings className="h-4 w-4" />
              Config
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "compare" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("compare")}
            >
              <BarChart3 className="h-4 w-4" />
              Compare
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "picklist" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("picklist")}
            >
              <FileJson className="h-4 w-4" />
              Picklist
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "scouts" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("scouts")}
            >
              <Folder className="h-4 w-4" />
              Scouts
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "teams" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("teams")}
            >
              <Upload className="h-4 w-4" />
              Teams
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "data" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("data")}
            >
              <BarChart3 className="h-4 w-4" />
              Data
            </button>
          </aside>

          <section
            className={`h-full rounded-2xl border border-white/10 bg-slate-950/60 p-4 ${
              projectSection === "data" && isDataGraphFullscreen ? "" : "backdrop-blur"
            } md:col-span-9 xl:col-span-10 ${
              projectSection === "data" && isDataGraphFullscreen ? "overflow-hidden" : "overflow-auto"
            }`}
          >
            {!selectedProject ? (
              <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">
                Project not found.
              </div>
            ) : projectSection === "overview" ? (
              <div className="space-y-4">
                <h1 className="text-4xl font-semibold tracking-tight">{selectedProject.name}</h1>
                <p className="text-white/70">{fromUnixSecondsToUpdatedLabel(selectedProject.updated_at)}</p>
                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                  <p className="text-sm text-white/80">Folder: {selectedProject.folder_path}</p>
                  <p className="mt-2 text-sm text-white/80">Scanner JSON: {selectedProject.json_file_path ?? "No JSON file yet"}</p>
                </div>
                <JsonViewerPage
                  initialPath={selectedProject.json_file_path ?? ""}
                  projectId={selectedProject.id}
                  fieldMapping={decodeFieldMapping}
                  qualitativeContentHash={projectConfig.qualitativeContentHash}
                  pitContentHash={projectConfig.pitContentHash}
                  embedded
                />
              </div>
            ) : projectSection === "config" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Config</h1>
                <p className="text-white/70">Configure content hashes for match, qualitative, and pit scouting payloads.</p>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                    <p className="mb-2 text-sm font-semibold text-white">Match Content Hash</p>
                    <Input
                      value={configMatchHashDraft}
                      onChange={(event) => setConfigMatchHashDraft(event.currentTarget.value)}
                      placeholder="Enter match hash"
                      className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                    />
                    <Button
                      type="button"
                      className="mt-3 w-full bg-blue-600 text-white hover:bg-blue-500"
                      onClick={() => void validateAndSaveConfigHash("match")}
                      disabled={isSavingConfig}
                    >
                      {isSavingConfig ? "Saving..." : "Validate + Save Match"}
                    </Button>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                    <p className="mb-2 text-sm font-semibold text-white">Qualitative Content Hash</p>
                    <Input
                      value={configQualitativeHashDraft}
                      onChange={(event) => setConfigQualitativeHashDraft(event.currentTarget.value)}
                      placeholder="Enter qualitative hash"
                      className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                    />
                    <Button
                      type="button"
                      className="mt-3 w-full bg-blue-600 text-white hover:bg-blue-500"
                      onClick={() => void validateAndSaveConfigHash("qualitative")}
                      disabled={isSavingConfig}
                    >
                      {isSavingConfig ? "Saving..." : "Validate + Save Qualitative"}
                    </Button>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                    <p className="mb-2 text-sm font-semibold text-white">Pit Content Hash</p>
                    <Input
                      value={configPitHashDraft}
                      onChange={(event) => setConfigPitHashDraft(event.currentTarget.value)}
                      placeholder="Enter pit hash"
                      className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                    />
                    <Button
                      type="button"
                      className="mt-3 w-full bg-blue-600 text-white hover:bg-blue-500"
                      onClick={() => void validateAndSaveConfigHash("pit")}
                      disabled={isSavingConfig}
                    >
                      {isSavingConfig ? "Saving..." : "Validate + Save Pit"}
                    </Button>
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Tag Point Values</p>
                      <p className="text-xs text-white/65">Points are shared across auto and teleop for the same base tag.</p>
                    </div>
                    <Button
                      type="button"
                      className="bg-blue-600 text-white hover:bg-blue-500"
                      onClick={() => void saveTagPointValues()}
                      disabled={isSavingTagPoints}
                    >
                      {isSavingTagPoints ? "Saving..." : "Save Tag Points"}
                    </Button>
                  </div>

                  {configurableTagBases.length === 0 ? (
                    <p className="text-sm text-white/60">No base tags discovered yet. Load match data to populate this list.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {configurableTagBases.map((baseTag) => (
                        <label key={`tag-points-${baseTag}`} className="flex items-center justify-between rounded-lg border border-white/15 bg-slate-950/70 px-3 py-2 text-sm text-white/85">
                          <span className="mr-3 truncate">{baseTag}</span>
                          <input
                            type="number"
                            step="0.1"
                            value={String((projectConfig.tagPointValues ?? {})[baseTag] ?? 1)}
                            onChange={(event) => setTagPointValue(baseTag, event.currentTarget.value)}
                            className="h-8 w-24 rounded border border-white/20 bg-slate-900 px-2 text-right text-white outline-none"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {configStatus ? <p className="text-sm text-white/80">{configStatus}</p> : null}
                {projectConfig.backgroundImage ? <p className="text-xs text-white/55">Resolved background image: {projectConfig.backgroundImage}</p> : null}
              </div>
            ) : projectSection === "compare" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Compare</h1>
                <p className="text-white/70">Create imaginary red/blue alliances, then compare weighted score output.</p>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-red-400/40 bg-red-950/20 p-4">
                    <p className="mb-3 text-sm font-semibold text-red-200">Red Alliance</p>
                    <div className="space-y-2">
                      {redAllianceTeams.map((team, index) => (
                        <Input
                          key={`red-team-${index}`}
                          value={team}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          onChange={(event) => updateAllianceTeamInput("red", index, event.currentTarget.value)}
                          placeholder={`Red team ${index + 1}`}
                          className="h-10 border-red-300/25 bg-slate-900/80 text-white placeholder:text-white/35"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-blue-400/40 bg-blue-950/20 p-4">
                    <p className="mb-3 text-sm font-semibold text-blue-200">Blue Alliance</p>
                    <div className="space-y-2">
                      {blueAllianceTeams.map((team, index) => (
                        <Input
                          key={`blue-team-${index}`}
                          value={team}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          onChange={(event) => updateAllianceTeamInput("blue", index, event.currentTarget.value)}
                          placeholder={`Blue team ${index + 1}`}
                          className="h-10 border-blue-300/25 bg-slate-900/80 text-white placeholder:text-white/35"
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                    <label className="space-y-1 text-sm text-white/80">
                      <span>Scoring Mode</span>
                      <select
                        value={compareScoreMode}
                        onChange={(event) => setCompareScoreMode(event.currentTarget.value as "tag" | "phase")}
                        className="h-10 w-full rounded-md border border-white/15 bg-slate-900 px-2 text-sm text-white"
                      >
                        <option value="tag">Single Tag</option>
                        <option value="phase">Auto / Teleop Total</option>
                      </select>
                    </label>

                    {compareScoreMode === "tag" ? (
                      <>
                        <label className="space-y-1 text-sm text-white/80 md:col-span-2">
                          <span>Metric / Tag</span>
                          <select
                            value={compareMetricTagSelection}
                            onChange={(event) => setCompareMetricTagSelection(event.currentTarget.value)}
                            className="h-10 w-full rounded-md border border-white/15 bg-slate-900 px-2 text-sm text-white"
                          >
                            {selectableCompareTags.map((tag) => (
                              <option key={`compare-tag-${tag}`} value={tag}>
                                {formatMetricTagLabel(tag)}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="space-y-1 text-sm text-white/80">
                          <span>Extra Weight</span>
                          <input
                            type="number"
                            step="0.1"
                            value={String(compareMetricWeight)}
                            onChange={(event) => {
                              const value = Number(event.currentTarget.value);
                              setCompareMetricWeight(Number.isFinite(value) ? value : 0);
                            }}
                            className="h-10 w-full rounded border border-white/20 bg-slate-900 px-2 text-white outline-none"
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="space-y-1 text-sm text-white/80">
                          <span>Phase</span>
                          <select
                            value={comparePhaseSelection}
                            onChange={(event) => setComparePhaseSelection(event.currentTarget.value as "auto" | "teleop")}
                            className="h-10 w-full rounded-md border border-white/15 bg-slate-900 px-2 text-sm text-white"
                          >
                            <option value="auto">Auto</option>
                            <option value="teleop">Teleop</option>
                          </select>
                        </label>

                        <label className="space-y-1 text-sm text-white/80">
                          <span>Points Per Action</span>
                          <input
                            type="number"
                            step="0.1"
                            value={String(comparePhasePointValue)}
                            onChange={(event) => {
                              const value = Number(event.currentTarget.value);
                              setComparePhasePointValue(Number.isFinite(value) ? value : 0);
                            }}
                            className="h-10 w-full rounded border border-white/20 bg-slate-900 px-2 text-white outline-none"
                          />
                        </label>

                        <div className="flex items-end text-xs text-white/65 md:col-span-2">
                          {comparePhaseTags.length} tags included from {comparePhaseSelection}.
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                  <p className="mb-2 text-sm text-white/75">Alliance Contribution Graph</p>
                  <div className="h-[360px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={allianceContributionRows} margin={{ top: 12, right: 18, left: 8, bottom: 12 }}>
                        <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                        <XAxis dataKey="alliance" tick={{ fill: "rgba(255,255,255,0.8)", fontSize: 12 }} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.8)", fontSize: 12 }} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "rgba(2,6,23,0.95)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: "0.75rem",
                            color: "white",
                          }}
                          formatter={(value, key, item) => {
                            const row = item.payload as AllianceContributionRow;
                            const numeric = typeof value === "number" ? value : Number(value);
                            const teamLabel = key === "slot1" ? row.team1 : key === "slot2" ? row.team2 : row.team3;
                            return [Number.isFinite(numeric) ? numeric.toFixed(2) : String(value), `Team ${teamLabel}`];
                          }}
                        />
                        <Legend
                          formatter={(value) => {
                            if (value === "slot1") {
                              return "Team 1";
                            }
                            if (value === "slot2") {
                              return "Team 2";
                            }
                            return "Team 3";
                          }}
                        />
                        <Bar dataKey="slot1" stackId="alliance" fill="#f97316" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="slot2" stackId="alliance" fill="#22c55e" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="slot3" stackId="alliance" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                    <div className="rounded-lg border border-red-400/30 bg-red-950/20 px-3 py-2 text-red-100">
                      Red Total: {allianceContributionRows[0]?.total.toFixed(2) ?? "0.00"}
                    </div>
                    <div className="rounded-lg border border-blue-400/30 bg-blue-950/20 px-3 py-2 text-blue-100">
                      Blue Total: {allianceContributionRows[1]?.total.toFixed(2) ?? "0.00"}
                    </div>
                  </div>
                </div>
              </div>
            ) : projectSection === "picklist" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Picklist</h1>
                <p className="text-white/70">Adjust metric weights, rank teams, drag reorder, and right-click to strike selected teams.</p>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                  <section className="space-y-3 rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-4">
                    <div className="flex items-center gap-2">
                      <select
                        value={activePicklist?.id ?? ""}
                        onChange={(event) => setActivePicklistId(event.currentTarget.value)}
                        className="h-10 flex-1 rounded-md border border-white/15 bg-slate-900 px-2 text-sm text-white"
                      >
                        {picklists.map((picklist) => (
                          <option key={picklist.id} value={picklist.id}>{picklist.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <Input
                        value={newPicklistName}
                        onChange={(event) => setNewPicklistName(event.currentTarget.value)}
                        placeholder="New picklist name"
                        className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                      />
                      <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={createNewPicklist}>Create</Button>
                    </div>

                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                      <Input
                        value={picklistMetricSearch}
                        onChange={(event) => setPicklistMetricSearch(event.currentTarget.value)}
                        placeholder="Search metric sliders..."
                        className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35"
                      />
                    </div>

                    <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
                      {picklistFilteredTags.map((tag) => {
                        const currentWeight = activePicklist?.metricWeights[tag] ?? 0;
                        return (
                          <div key={`weight-${tag}`} className="rounded-lg border border-white/10 bg-slate-950/60 p-3">
                            <p className="mb-2 text-xs text-white/60">{formatMetricTagLabel(tag)}</p>
                            <input
                              type="range"
                              min={-3}
                              max={3}
                              step={0.1}
                              value={currentWeight}
                              onChange={(event) => setPicklistMetricWeight(tag, Number(event.currentTarget.value))}
                              className="w-full"
                            />
                            <p className="mt-1 text-xs text-white/70">Weight: {currentWeight.toFixed(1)}</p>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section className="space-y-3 rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-8">
                    <p className="text-sm text-white/70">Ranked Teams (best to worst by weighted score)</p>
                    <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
                      {picklistRows.map((row, index) => {
                        const isStruck = activePicklist?.struckTeams.includes(row.team) ?? false;
                        return (
                          <button
                            key={`pick-row-${row.team}`}
                            type="button"
                            draggable
                            onDragStart={() => setDraggingPickTeam(row.team)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => {
                              if (draggingPickTeam) {
                                movePicklistTeam(draggingPickTeam, row.team);
                              }
                              setDraggingPickTeam(null);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              togglePicklistStrike(row.team);
                            }}
                            onClick={() => selectedProject && navigateTeam(selectedProject.id, row.team)}
                            className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                              isStruck
                                ? "border-white/10 bg-slate-900/40 text-white/45 line-through"
                                : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold">#{index + 1} • Team {row.team}</span>
                              <span className="text-xs text-white/70">{row.score.toFixed(2)}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </div>
            ) : projectSection === "scouts" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Scouts</h1>
                <p className="text-white/70">Filter by `scouter` and select a scout.</p>

                <div className="relative max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                  <Input
                    value={scoutSearch}
                    onChange={(event) => setScoutSearch(event.currentTarget.value)}
                    placeholder="Search scouts..."
                    className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35"
                  />
                </div>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading scouts...</div>
                ) : filteredScoutNames.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No scouts found from the `scouter` field in this JSON.</div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filteredScoutNames.map((scout) => {
                      const selected = selectedScout === scout;
                      return (
                        <button
                          key={scout}
                          type="button"
                          onClick={() => setSelectedScout(scout)}
                          className={`rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
                            selected
                              ? "border-blue-400/70 bg-blue-600/20 text-white"
                              : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                          }`}
                        >
                          {scout}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : projectSection === "data" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Data</h1>
                <p className="text-white/70">Click X or Y axis, then click a tag to populate the graph using all teams and all matches.</p>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading data...</div>
                ) : allNumericTags.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No numeric tags available from this JSON.</div>
                ) : (
                  <div className={isDataGraphFullscreen ? "fixed inset-0 z-[200] overflow-y-auto bg-slate-950 p-4 md:p-6" : ""}>
                    <div className="mb-3 flex items-center justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"
                        onClick={() => setIsDataGraphFullscreen((current) => !current)}
                      >
                        {isDataGraphFullscreen ? "Exit Full Screen" : "Full Screen"}
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                      <aside className="rounded-xl border border-white/10 bg-slate-900/50 p-3 xl:col-span-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Data Tags</p>
                        <p className="mb-3 text-xs text-white/50">
                          {dataGraphType === "bar"
                            ? "Bar mode: select Y then optional Y2. Y2 must be matching auto/teleop pair."
                            : "Select top axis card (X/Y), then choose a metric below."}
                        </p>

                        <div className="max-h-[calc(100dvh-360px)] space-y-3 overflow-y-auto pr-1">
                          <div className="rounded-lg border border-white/15 bg-slate-900/70 p-2">
                            <p className="mb-2 text-xs uppercase text-white/55">Select Axis ({dataTagActiveAxis.toUpperCase()})</p>
                            <div className="space-y-1.5">
                              {dataTagGroups.map((group) => {
                                const isExpandedBase = expandedDataMetricBase === group.base;
                                const isSelectedBase = selectedDataBaseForActiveAxis === group.base;
                                const axisBaseClass = dataTagActiveAxis === "x"
                                  ? "border-blue-400/70 bg-blue-600/20"
                                  : dataTagActiveAxis === "y"
                                    ? "border-amber-400/70 bg-amber-600/20"
                                    : "border-emerald-400/70 bg-emerald-600/20";

                                return (
                                  <div key={`data-group-${group.base}`} className="rounded-md border border-white/10 bg-slate-950/60 p-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const defaultVariant = group.variants[0]?.key ?? "value";
                                        setExpandedDataMetricBase((previous) => (previous === group.base ? "" : group.base));
                                        setExpandedDataMetricVariant(defaultVariant);

                                        if (dataTagActiveAxis === "x") {
                                          setSelectedDataXBaseMetric(group.base);
                                          setSelectedDataXVariant(defaultVariant);
                                        } else if (dataTagActiveAxis === "y2") {
                                          setSelectedDataY2BaseMetric(group.base);
                                          setSelectedDataY2Variant(defaultVariant);
                                        } else {
                                          setSelectedDataYBaseMetric(group.base);
                                          setSelectedDataYVariant(defaultVariant);
                                        }
                                      }}
                                      className={`w-full rounded-md border px-2 py-1.5 text-left text-xs font-medium transition ${
                                        isSelectedBase
                                          ? `${axisBaseClass} text-white`
                                          : "border-white/15 bg-slate-900 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                                      }`}
                                    >
                                      {group.base}
                                    </button>

                                    {isExpandedBase ? (
                                      <div className="mt-1.5 space-y-1.5">
                                        {group.variants.map((variant) => {
                                          const isExpandedVariant = expandedDataMetricVariant === variant.key;
                                          const isSelectedVariant = isSelectedBase && selectedDataVariantForActiveAxis === variant.key;
                                          const variantClass = dataTagActiveAxis === "x"
                                            ? "border-blue-300/70 bg-blue-500/20"
                                            : dataTagActiveAxis === "y"
                                              ? "border-amber-300/70 bg-amber-500/20"
                                              : "border-emerald-300/70 bg-emerald-500/20";

                                          return (
                                            <div key={`data-variant-${group.base}-${variant.key}`} className="rounded-md border border-white/10 bg-slate-900/60 p-1.5">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setExpandedDataMetricVariant((previous) => (previous === variant.key ? null : variant.key));

                                                  if (dataTagActiveAxis === "x") {
                                                    setSelectedDataXBaseMetric(group.base);
                                                    setSelectedDataXVariant(variant.key);
                                                  } else if (dataTagActiveAxis === "y2") {
                                                    setSelectedDataY2BaseMetric(group.base);
                                                    setSelectedDataY2Variant(variant.key);
                                                  } else {
                                                    setSelectedDataYBaseMetric(group.base);
                                                    setSelectedDataYVariant(variant.key);
                                                  }
                                                }}
                                                className={`w-full rounded-md border px-2 py-1 text-left text-[11px] font-medium transition ${
                                                  isSelectedVariant
                                                    ? `${variantClass} text-white`
                                                    : "border-white/15 bg-slate-950/70 text-white/85 hover:border-blue-400/60 hover:bg-blue-600/20"
                                                }`}
                                              >
                                                {variant.label}
                                              </button>

                                              {isExpandedVariant ? (
                                                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                                                  {(["auto", "teleop"] as const).map((phase) => {
                                                    const enabled = Boolean(variant.tagsByPhase[phase]);
                                                    const selected = isSelectedVariant && selectedDataPhaseForActiveAxis === phase;
                                                    const phaseClass = dataTagActiveAxis === "x"
                                                      ? "border-blue-400/70 bg-blue-600/20"
                                                      : dataTagActiveAxis === "y"
                                                        ? "border-amber-400/70 bg-amber-600/20"
                                                        : "border-emerald-400/70 bg-emerald-600/20";
                                                    return (
                                                      <button
                                                        key={`data-phase-${group.base}-${variant.key}-${phase}`}
                                                        type="button"
                                                        disabled={!enabled}
                                                        onClick={() => {
                                                          if (!enabled) {
                                                            return;
                                                          }

                                                          if (dataTagActiveAxis === "x") {
                                                            setSelectedDataXBaseMetric(group.base);
                                                            setSelectedDataXVariant(variant.key);
                                                            setSelectedDataXPhase(phase);
                                                          } else if (dataTagActiveAxis === "y2") {
                                                            setSelectedDataY2BaseMetric(group.base);
                                                            setSelectedDataY2Variant(variant.key);
                                                            setSelectedDataY2Phase(phase);
                                                          } else {
                                                            setSelectedDataYBaseMetric(group.base);
                                                            setSelectedDataYVariant(variant.key);
                                                            setSelectedDataYPhase(phase);
                                                          }
                                                        }}
                                                        className={`rounded-md border px-2 py-1 text-xs transition ${
                                                          !enabled
                                                            ? "border-white/10 bg-slate-900/40 text-white/25"
                                                            : selected
                                                              ? `${phaseClass} text-white`
                                                              : "border-white/15 bg-slate-900/80 text-white/85 hover:border-blue-400/60 hover:bg-blue-600/20"
                                                        }`}
                                                      >
                                                        {phase}
                                                      </button>
                                                    );
                                                  })}
                                                </div>
                                              ) : null}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {dataGraphType === "weighted" ? (
                            <div className="space-y-2 rounded-lg border border-white/15 bg-slate-900/70 p-2">
                              <p className="text-xs uppercase text-white/55">Weighted Metrics</p>
                              {weightedMetricSelections.map((selection) => (
                                <div key={selection.id} className="rounded-md border border-white/10 bg-slate-950/70 p-2">
                                  <select
                                    value={selection.baseMetric}
                                    onChange={(event) => {
                                      const nextValue = event.currentTarget.value;
                                      setWeightedMetricSelections((previous) =>
                                        previous.map((item) => (item.id === selection.id ? { ...item, baseMetric: nextValue } : item)),
                                      );
                                    }}
                                    className="mb-1 h-8 w-full rounded-md border border-white/15 bg-slate-900 px-2 text-xs text-white"
                                  >
                                    {basePhaseMetrics.map((item) => (
                                      <option key={`w-base-${selection.id}-${item.base}`} value={item.base}>{item.base}</option>
                                    ))}
                                  </select>
                                  <div className="grid grid-cols-2 gap-2">
                                    <select
                                      value={selection.phase}
                                      onChange={(event) => {
                                        const nextPhase = event.currentTarget.value as "auto" | "teleop";
                                        setWeightedMetricSelections((previous) =>
                                          previous.map((item) => (item.id === selection.id ? { ...item, phase: nextPhase } : item)),
                                        );
                                      }}
                                      className="h-8 rounded-md border border-white/15 bg-slate-900 px-2 text-xs text-white"
                                    >
                                      <option value="auto">auto</option>
                                      <option value="teleop">teleop</option>
                                    </select>
                                    <Input
                                      value={String(selection.weight)}
                                      onChange={(event) => {
                                        const parsed = Number(event.currentTarget.value);
                                        setWeightedMetricSelections((previous) =>
                                          previous.map((item) =>
                                            item.id === selection.id
                                              ? { ...item, weight: Number.isFinite(parsed) ? parsed : 0 }
                                              : item,
                                          ),
                                        );
                                      }}
                                      className="h-8 border-white/10 bg-slate-900/80 text-xs text-white"
                                      placeholder="weight"
                                    />
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="mt-2 h-7 w-full border-white/20 bg-slate-900/60 text-xs text-white hover:bg-slate-800"
                                    onClick={() => {
                                      setWeightedMetricSelections((previous) => previous.filter((item) => item.id !== selection.id));
                                    }}
                                    disabled={weightedMetricSelections.length <= 1}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                className="h-8 w-full border-white/20 bg-slate-900/60 text-xs text-white hover:bg-slate-800"
                                onClick={() => {
                                  const firstBase = basePhaseMetrics[0]?.base ?? "";
                                  if (!firstBase) {
                                    return;
                                  }
                                  setWeightedMetricSelections((previous) => [
                                    ...previous,
                                    {
                                      id: `metric-${Date.now()}-${previous.length}`,
                                      baseMetric: firstBase,
                                      phase: "auto",
                                      weight: 1,
                                    },
                                  ]);
                                }}
                              >
                                Add Metric
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </aside>

                      <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-9">
                        <div className={`mb-3 grid grid-cols-1 gap-3 ${dataGraphType === "bar" ? "md:grid-cols-3" : "md:grid-cols-3"}`}>
                          {dataGraphType === "scatter" ? (
                            <button
                              type="button"
                              onClick={() => setActiveDataAxis("x")}
                              className={`rounded-lg border px-3 py-2 text-left ${
                                activeDataAxis === "x"
                                  ? "border-blue-400/70 bg-blue-600/20"
                                  : "border-dashed border-white/25 bg-slate-950/60"
                              }`}
                            >
                              <p className="text-xs text-white/55">X Axis</p>
                              <p className="mt-1 text-sm font-semibold text-white">{selectedDataXTag ? formatMetricTagLabel(selectedDataXTag) : "Click then select tag"}</p>
                            </button>
                          ) : null}

                          <button
                            type="button"
                            onClick={() => setActiveDataAxis("y")}
                            className={`rounded-lg border px-3 py-2 text-left ${
                              activeDataAxis === "y"
                                ? "border-amber-400/70 bg-amber-600/20"
                                : "border-dashed border-white/25 bg-slate-950/60"
                            }`}
                          >
                            <p className="text-xs text-white/55">Y Axis</p>
                            <p className="mt-1 text-sm font-semibold text-white">{selectedDataYTag ? formatMetricTagLabel(selectedDataYTag) : "Click then select tag"}</p>
                          </button>

                          {dataGraphType === "bar" ? (
                            <button
                              type="button"
                              onClick={() => setActiveDataAxis("y2")}
                              className={`rounded-lg border px-3 py-2 text-left ${
                                activeDataAxis === "y2"
                                  ? "border-emerald-400/70 bg-emerald-600/20"
                                  : "border-dashed border-white/25 bg-slate-950/60"
                              }`}
                            >
                              <p className="text-xs text-white/55">Y2 Axis (optional)</p>
                              <p className="mt-1 text-sm font-semibold text-white">{selectedDataYTagSecondary ? formatMetricTagLabel(selectedDataYTagSecondary) : "Click then select phase pair"}</p>
                            </button>
                          ) : null}

                          <div className="flex items-end gap-2">
                            <Button
                              type="button"
                              variant={dataGraphType === "scatter" ? "default" : "outline"}
                              className={dataGraphType === "scatter" ? "bg-blue-600 text-white hover:bg-blue-500" : "border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"}
                              onClick={() => setDataGraphType("scatter")}
                            >
                              Scatter
                            </Button>
                            <Button
                              type="button"
                              variant={dataGraphType === "bar" ? "default" : "outline"}
                              className={dataGraphType === "bar" ? "bg-blue-600 text-white hover:bg-blue-500" : "border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"}
                              onClick={() => {
                                setDataGraphType("bar");
                                setDataTagSelectionError("");
                              }}
                            >
                              Bar
                            </Button>
                            <Button
                              type="button"
                              variant={dataGraphType === "weighted" ? "default" : "outline"}
                              className={dataGraphType === "weighted" ? "bg-blue-600 text-white hover:bg-blue-500" : "border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"}
                              onClick={() => {
                                setDataGraphType("weighted");
                                setDataTagSelectionError("");
                              }}
                            >
                              Weighted
                            </Button>
                          </div>
                        </div>

                        {dataTagSelectionError ? <p className="mb-2 text-xs text-amber-300">{dataTagSelectionError}</p> : null}

                        <div className="mb-3 flex items-center gap-2">
                          <Search className="h-4 w-4 text-white/55" />
                          <Input
                            value={dataTeamSearch}
                            onChange={(event) => setDataTeamSearch(event.currentTarget.value)}
                            placeholder="Search team to highlight..."
                            className="h-9 max-w-xs border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                          />
                        </div>

                        {normalizedDataTeamSearch ? (
                          <p className="mb-2 text-xs text-white/70">
                            {dataGraphType === "scatter"
                              ? foundScatterTeam
                                ? `Highlighted Team ${foundScatterTeam.team} at X ${foundScatterTeam.x.toFixed(2)}, Y ${foundScatterTeam.y.toFixed(2)}.`
                                : "No matching team found in scatter data."
                              : foundBarTeamIndex >= 0
                                ? `Highlighted Team ${dataBarRows[foundBarTeamIndex].team} at rank ${foundBarTeamIndex + 1}.`
                                : "No matching team found in bar data."}
                          </p>
                        ) : null}

                        <p className="mb-3 text-xs text-white/55">
                          {dataGraphType === "scatter"
                            ? "Scatter plot is sorted by Y value (best to worst) across all teams and matches."
                            : "Bar graph ranks teams from best to worst by total score (Y + Y2 when selected)."}
                        </p>

                        <div className={isDataGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[280px] w-full" : "h-[460px] w-full"}>
                          <ResponsiveContainer width="100%" height="100%">
                            {dataGraphType === "scatter" ? (
                              <ScatterChart
                                margin={{ top: 12, right: 20, left: 10, bottom: 14 }}
                                onClick={(chartState) => {
                                  const payload = (chartState as { activePayload?: Array<{ payload?: { team?: string } }> } | undefined)?.activePayload?.[0]?.payload;
                                  const team = typeof payload?.team === "string" ? payload.team : "";
                                  if (team) {
                                    openMatchFromDataTeam(team);
                                  }
                                }}
                              >
                                <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                                <XAxis
                                  type="number"
                                  dataKey="x"
                                  name={selectedDataXTag ? formatMetricTagLabel(selectedDataXTag) : "x"}
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                />
                                <YAxis
                                  type="number"
                                  dataKey="y"
                                  name={selectedDataYTag ? formatMetricTagLabel(selectedDataYTag) : "y"}
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                  width={70}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(2,6,23,0.95)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    borderRadius: "0.75rem",
                                    color: "white",
                                  }}
                                  formatter={(value, name, item) => {
                                    const row = item.payload as { team: string; matches: number };
                                    const numeric = typeof value === "number" ? value : Number(value);
                                    const axisKey = String(item.dataKey ?? name);
                                    const label = axisKey === "x" ? selectedDataXTag : selectedDataYTag;
                                    return [
                                      `${Number.isFinite(numeric) ? numeric.toFixed(2) : String(value)} • Team ${row.team} • Matches ${row.matches}`,
                                      label || String(name),
                                    ];
                                  }}
                                />
                                <Scatter data={regularScatterRows} fill="#60a5fa">
                                  <LabelList dataKey="team" position="bottom" fill="rgba(255,255,255,0.72)" fontSize={11} />
                                </Scatter>
                                {highlightedScatterRows.length > 0 ? (
                                  <Scatter data={highlightedScatterRows} fill="#f59e0b">
                                    <LabelList dataKey="team" position="bottom" fill="rgba(251,191,36,0.95)" fontSize={12} fontWeight={700} />
                                  </Scatter>
                                ) : null}
                              </ScatterChart>
                            ) : dataGraphType === "bar" ? (
                              <BarChart
                                data={dataBarRows}
                                margin={{ top: 12, right: 20, left: 10, bottom: 70 }}
                                onClick={(chartState) => {
                                  const payload = (chartState as { activePayload?: Array<{ payload?: { team?: string } }> } | undefined)?.activePayload?.[0]?.payload;
                                  const team = typeof payload?.team === "string" ? payload.team : "";
                                  if (team) {
                                    openMatchFromDataTeam(team);
                                  }
                                }}
                              >
                                <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                                <XAxis
                                  dataKey="team"
                                  interval={0}
                                  angle={-35}
                                  textAnchor="end"
                                  height={70}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 11 }}
                                />
                                <YAxis
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                  width={70}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(2,6,23,0.95)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    borderRadius: "0.75rem",
                                    color: "white",
                                  }}
                                  formatter={(value, name, item) => {
                                    const numeric = typeof value === "number" ? value : Number(value);
                                    const labelName = name === "secondaryValue"
                                      ? (selectedDataYTagSecondary ? formatMetricTagLabel(selectedDataYTagSecondary) : "Y2")
                                      : (selectedDataYTag ? formatMetricTagLabel(selectedDataYTag) : "Y");
                                    const row = item.payload as { totalValue: number };
                                    return [
                                      `${Number.isFinite(numeric) ? numeric.toFixed(2) : String(value)} • Total ${row.totalValue.toFixed(2)}`,
                                      `${labelName} (avg)`,
                                    ];
                                  }}
                                  labelFormatter={(label) => `Team ${label}`}
                                />
                                <Bar dataKey="primaryValue" stackId="score" radius={[0, 0, 0, 0]} name={selectedDataYTag ? formatMetricTagLabel(selectedDataYTag) : "Y"}>
                                  {dataBarRows.map((row) => (
                                    <Cell key={`primary-${row.team}`} fill={highlightedBarTeams.has(row.team) ? "#93c5fd" : "#60a5fa"} />
                                  ))}
                                </Bar>
                                {selectedDataYTagSecondary ? (
                                  <Bar dataKey="secondaryValue" stackId="score" radius={[6, 6, 0, 0]} name={selectedDataYTagSecondary ? formatMetricTagLabel(selectedDataYTagSecondary) : "Y2"}>
                                    {dataBarRows.map((row) => (
                                      <Cell key={`secondary-${row.team}`} fill={highlightedBarTeams.has(row.team) ? "#facc15" : "#f59e0b"} />
                                    ))}
                                  </Bar>
                                ) : null}
                              </BarChart>
                            ) : (
                              <BarChart data={weightedDataRows} margin={{ top: 12, right: 20, left: 10, bottom: 70 }}>
                                <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                                <XAxis
                                  dataKey="team"
                                  interval={0}
                                  angle={-35}
                                  textAnchor="end"
                                  height={70}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 11 }}
                                />
                                <YAxis
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                  width={70}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(2,6,23,0.95)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    borderRadius: "0.75rem",
                                    color: "white",
                                  }}
                                  formatter={(value, _name, item) => {
                                    const numeric = typeof value === "number" ? value : Number(value);
                                    const row = item.payload as { metricBreakdown: Record<string, number> };
                                    const breakdown = Object.entries(row.metricBreakdown)
                                      .map(([tag, weighted]) => `${formatMetricTagLabel(tag)}: ${weighted.toFixed(2)}`)
                                      .join(" • ");
                                    return [
                                      `${Number.isFinite(numeric) ? numeric.toFixed(2) : String(value)}${breakdown ? ` • ${breakdown}` : ""}`,
                                      "Weighted Score",
                                    ];
                                  }}
                                  labelFormatter={(label) => `Team ${label}`}
                                />
                                <Bar dataKey="weightedScore" name="Weighted Score" fill="#60a5fa" radius={[6, 6, 0, 0]} />
                              </BarChart>
                            )}
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
                <p className="text-white/70">Filter by the `team` tag and select a team number.</p>

                <div className="relative max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                  <Input
                    value={teamSearch}
                    onChange={(event) => setTeamSearch(event.currentTarget.value)}
                    placeholder="Search teams..."
                    className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35"
                  />
                </div>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading teams...</div>
                ) : filteredTeamNumbers.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No teams found from the `team` field in this JSON.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                    {filteredTeamNumbers.map((team) => {
                      const selected = selectedTeam === team;
                      return (
                        <button
                          key={team}
                          type="button"
                          onClick={() => setSelectedTeam(team)}
                          onDoubleClick={() => navigateTeam(selectedProject.id, team)}
                          className={`rounded-lg border px-3 py-2 text-center text-sm font-medium transition ${
                            selected
                              ? "border-blue-400/70 bg-blue-600/20 text-white"
                              : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                          }`}
                        >
                          {team}
                        </button>
                      );
                    })}
                  </div>
                )}

                {selectedTeam ? (
                  <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/50 p-4">
                    <p className="text-sm text-white/75">
                      Team <span className="font-semibold text-white">{selectedTeam}</span> • Matches: {selectedTeamMatchCount}
                    </p>

                    {teamAverages.length === 0 ? (
                      <p className="text-sm text-white/60">No numeric tags available for averages.</p>
                    ) : (
                      <div className="grid max-h-[320px] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {teamAverages.map((item) => (
                          <div key={item.tag} className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                            <p className="text-xs uppercase tracking-wide text-white/55">{formatMetricTagLabel(item.tag)}</p>
                            <p className="mt-2 text-2xl font-semibold text-white">{item.average.toFixed(2)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </main>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogContent className="border-white/10 bg-slate-950 text-white sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
              <DialogDescription className="text-white/65">This creates a new folder under GoonHQMain/projects.</DialogDescription>
            </DialogHeader>
            <Input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
            <Input
              value={createProjectContentHash}
              onChange={(event) => setCreateProjectContentHash(event.target.value)}
              placeholder="Match content hash"
              className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
            />
            <DialogFooter>
              <Button type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreatingProject}>
                Cancel
              </Button>
              <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={() => void handleCreateProject()} disabled={isCreatingProject}>
                {isCreatingProject ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
        <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800"
            onClick={() => setIsDebugDialogOpen(true)}
          >
            <Settings className="mr-2 h-4 w-4" />
            Backend Debug
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800"
            onClick={() => void handleSetRootFolder()}
            disabled={isSettingRootFolder}
          >
            <Folder className="mr-2 h-4 w-4" />
            {isSettingRootFolder ? "Setting Root..." : "Set Root Folder"}
          </Button>
          <Button type="button" className="h-10 rounded-xl bg-blue-600 px-5 text-white hover:bg-blue-500" onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
          <Button type="button" variant="outline" className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800" onClick={() => void refreshWorkspace()}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </div>
      </header>

      <main className="grid h-[calc(100vh-73px)] grid-cols-1 items-start gap-4 p-4 md:grid-cols-12">
        <aside className="flex h-full flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-3 xl:col-span-2">
          <div className="relative mb-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects..." className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35" />
          </div>

          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Projects</p>
          <div className="rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2 text-sm text-white/70">Total Projects: {workspace?.projects.length ?? 0}</div>

          <div className="mt-auto pt-6">
            <Button type="button" variant="outline" className="w-full justify-start border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => navigateViewer()}>
              <FileJson className="mr-2 h-4 w-4" />
              Open JSON Viewer
            </Button>
          </div>
        </aside>

        <section className="h-full overflow-auto rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-9 xl:col-span-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h1 className="text-4xl font-semibold tracking-tight">My Projects</h1>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search..." className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35" />
            </div>
          </div>

          {workspace?.root_path ? <p className="mb-2 text-xs text-white/45">Workspace root: {workspace.root_path}</p> : null}
          {workspaceError ? <p className="mb-2 text-sm text-red-300">{workspaceError}</p> : null}

          {isLoadingWorkspace ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">Loading projects...</div>
          ) : displayedProjects.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">No projects found in GoonHQMain/projects.</div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {displayedProjects.map((project) => (
                <article key={project.id} className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70 transition hover:border-blue-400/45">
                  <div className="h-40 w-full border-b border-white/10" style={{ background: cardGradient }} />
                  <button type="button" className="w-full p-4 text-left" onClick={() => navigateProject(project.id)}>
                    <h2 className="text-3xl font-semibold leading-tight">{project.name}</h2>
                    <p className="mt-2 text-base text-white/65">{fromUnixSecondsToUpdatedLabel(project.updated_at)}</p>
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <Dialog open={isDebugDialogOpen} onOpenChange={setIsDebugDialogOpen}>
        <DialogContent className="border-white/10 bg-slate-950 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Backend Debug</DialogTitle>
            <DialogDescription className="text-white/65">Validate a content hash against Supabase and confirm backend connectivity.</DialogDescription>
          </DialogHeader>
          <Input
            value={debugContentHash}
            onChange={(event) => setDebugContentHash(event.target.value)}
            placeholder="Content hash"
            className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
          />
          <select
            value={debugScoutType}
            onChange={(event) => setDebugScoutType(event.currentTarget.value as "match" | "qualitative" | "pit")}
            className="h-10 w-full rounded-md border border-white/10 bg-slate-900/80 px-3 text-sm text-white"
          >
            <option value="match">match</option>
            <option value="qualitative">qualitative</option>
            <option value="pit">pit</option>
          </select>
          {debugMessage ? <p className="text-sm text-white/80">{debugMessage}</p> : null}
          {debugResult ? (
            <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3 text-xs text-white/75">
              <p>valid: {String(debugResult.valid)}</p>
              <p>scoutType: {debugResult.scout_type ?? "unknown"}</p>
              <p>has fieldMapping: {String(Boolean(debugResult.field_mapping))}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => setIsDebugDialogOpen(false)}>
              Close
            </Button>
            <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={() => void handleDebugValidateHash()} disabled={isRunningDebugValidation}>
              {isRunningDebugValidation ? "Validating..." : "Validate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="border-white/10 bg-slate-950 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription className="text-white/65">This creates a new folder under GoonHQMain/projects.</DialogDescription>
          </DialogHeader>
          <Input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
          <Input
            value={createProjectContentHash}
            onChange={(event) => setCreateProjectContentHash(event.target.value)}
            placeholder="Match content hash"
            className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
          />
          <DialogFooter>
            <Button type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreatingProject}>
              Cancel
            </Button>
            <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={() => void handleCreateProject()} disabled={isCreatingProject}>
              {isCreatingProject ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
